import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Find the function NAME's `qualified_identifier` (`Foo::bar`) inside a
 * declarator, skipping the `parameter_list` — a parameter with a qualified type
 * (`const std::string& x`) must NOT be mistaken for the method name. Without the
 * skip, a plain free function `std::string TableFileName(const std::string&...)`
 * was named `string` (from the parameter type), so calls to it never resolved
 * and its file looked like nothing depended on it.
 */
function findDeclaratorQualifiedId(declarator: SyntaxNode): SyntaxNode | undefined {
  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') return current;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      // Don't descend into parameters or the trailing return type — their types
      // (`const std::string&`, `-> std::string`) aren't the function name.
      if (child && child.type !== 'parameter_list' && child.type !== 'trailing_return_type') {
        queue.push(child);
      }
    }
  }
  return undefined;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts[parts.length - 1];
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
}

/**
 * Built-in / non-class return types that can never be a method receiver. We
 * store no `returnType` for these so resolution never tries to resolve a method
 * on `void` / `int` / etc.
 */
const CPP_NON_CLASS_RETURN = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'size_t', 'ssize_t', 'auto', 'wchar_t', 'char8_t', 'char16_t',
  'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'nullptr_t',
]);

/**
 * Normalize a C++ return type to the bare class name a method could be called
 * on. Unwraps smart-pointer / optional wrappers to their element type
 * (`std::unique_ptr<Widget>` → `Widget`) so a factory's `->method()` resolves on
 * the pointee. Strips cv-qualifiers, `&`/`*`, namespace qualifiers, and other
 * template args. Returns undefined for primitives / void / `auto` / empty.
 */
export function normalizeCppReturnType(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  // Unwrap smart pointers / optional to their pointee (the thing you call `->` on).
  const wrapper = t.match(/\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper && wrapper[1]) t = wrapper[1];
  t = t
    .replace(/\b(?:const|volatile|typename|struct|class|enum)\b/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  const last = t.split('::').filter(Boolean).pop();
  if (!last) return undefined;
  if (CPP_NON_CLASS_RETURN.has(last)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * A function/method's return type lives in the `function_definition`'s `type`
 * field (`Metrics& Metrics::instance()` → `Metrics`). Constructors, destructors,
 * and conversion operators have no `type` field → undefined.
 */
function extractCppReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  return normalizeCppReturnType(getNodeText(typeNode, source));
}

/**
 * Replace a statement-like macro invocation with `0;` (padded to the same
 * byte length, newlines preserved) so tree-sitter's C/C++ parser doesn't
 * close the enclosing compound_statement early. The original text is the
 * full invocation (e.g. `SWITCH(x)` or `DEFAULT`); we overwrite the first
 * two chars with `0;` and blank the rest to spaces, keeping any `\n`s so
 * line numbers and byte offsets stay identical.
 */
function replaceWithSemicolon(text: string): string {
  const chars = [...text];
  if (chars.length >= 2) {
    chars[0] = '0';
    chars[1] = ';';
    for (let i = 2; i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  } else if (chars.length === 1) {
    // Single-char macro → null statement.
    chars[0] = ';';
  }
  return chars.join('');
}

/**
 * Pre-parse transform for C/C++: replace statement-level macro invocations
 * with `0;` so tree-sitter's parser doesn't close the compound_statement
 * early on macros that expand to brace-balanced code WITHOUT a trailing
 * semicolon (e.g. open5gs SWITCH/CASE/DEFAULT/END in lib/core/ogs-macros.h).
 *
 * Tree-sitter's C/C++ grammars lack a preprocessor, so a bare `SWITCH(x)`
 * (no trailing `;`) parses as a call_expression that triggers error
 * recovery; as errors accumulate the parser eventually closes the function
 * body prematurely, dropping every subsequent call/statement into the
 * translation_unit. Replacing the invocation with a legal `0;` expression
 * statement keeps the compound_statement open so visitFunctionBody can
 * still walk every case body.
 *
 * A macro invocation is "statement-like" (and thus replaced) when ALL of:
 *   1. the identifier is in the known macro set (`macroNames`)
 *   2. paren depth is 0 (not inside a call/arg list — excludes macro
 *      constants used as arguments like `CASE(MACRO_CONST)` or
 *      `foo(x, MACRO_CONST)`)
 *   3. NOT followed by `;` (no trailing semicolon → not a regular call;
 *      tree-sitter already handles those)
 *   4. NOT followed by `{` (preserves the existing isMisparsedFunction
 *      pattern `MACRO(params) { body }` — replacing it would break that
 *      mechanism)
 *
 * String/char literals, line/block comments, and preprocessor directives
 * are skipped verbatim. The output preserves the exact byte length of the
 * input (replaced text is space-padded, newlines kept) so node positions
 * and getNodeText remain correct.
 */
function preprocessStatementMacros(source: string, macroNames?: Set<string>): string {
  if (!macroNames || macroNames.size === 0) return source;

  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

  // Safe char access — returns '' for out-of-bounds (correct for all
  // equality comparisons below; the loop guards ensure we never push the
  // empty string from an out-of-range read).
  const at = (idx: number): string => (idx >= 0 && idx < source.length) ? source[idx]! : '';

  const out: string[] = [];
  let i = 0;
  let parenDepth = 0;
  const n = source.length;

  while (i < n) {
    const c = at(i);

    // Line comment — copy verbatim to end of line.
    if (c === '/' && at(i + 1) === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // Block comment — copy verbatim through `*/`.
    if (c === '/' && at(i + 1) === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }

    // String literal — copy verbatim through the closing quote (handle escapes).
    if (c === '"') {
      out.push(c);
      i++;
      while (i < n) {
        const ch = at(i);
        out.push(ch);
        i++;
        if (ch === '\\') {
          if (i < n) {
            out.push(at(i));
            i++;
          }
          continue;
        }
        if (ch === '"') break;
      }
      continue;
    }

    // Char literal — copy verbatim through the closing quote (handle escapes).
    if (c === "'") {
      out.push(c);
      i++;
      while (i < n) {
        const ch = at(i);
        out.push(ch);
        i++;
        if (ch === '\\') {
          if (i < n) {
            out.push(at(i));
            i++;
          }
          continue;
        }
        if (ch === "'") break;
      }
      continue;
    }

    // Preprocessor directive — copy the entire line verbatim (and any
    // line-continuation backslash continuations).
    if (c === '#') {
      // Only treat as preprocessor if at the start of a logical line
      // (only whitespace before it on this line).
      let lineStart = i;
      while (lineStart > 0 && at(lineStart - 1) !== '\n') lineStart--;
      let onlyWs = true;
      for (let k = lineStart; k < i; k++) {
        if (!/\s/.test(at(k))) { onlyWs = false; break; }
      }
      if (onlyWs) {
        while (i < n) {
          out.push(at(i));
          if (at(i) === '\n') {
            // Honor line continuation: a backslash immediately before the
            // newline keeps the directive alive on the next line.
            if (at(i - 1) === '\\') { i++; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      // Otherwise fall through (an inline `#` outside directives — rare).
    }

    // Track paren depth.
    if (c === '(') { parenDepth++; out.push(c); i++; continue; }
    if (c === ')') { parenDepth--; out.push(c); i++; continue; }

    // Identifier at depth 0 — candidate statement-level macro.
    if (isIdentStart(c) && parenDepth === 0) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);

      if (macroNames.has(ident)) {
        // Find the end of the invocation: function-like MACRO(...) includes
        // through the matching `)`; object-like MACRO is just the identifier.
        let invEnd = j;
        let k = j;
        while (k < n && (at(k) === ' ' || at(k) === '\t')) k++;
        if (k < n && at(k) === '(') {
          let depth = 1;
          invEnd = k + 1;
          while (invEnd < n && depth > 0) {
            const ch = at(invEnd);
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            // Don't follow parens inside string/char literals.
            else if (ch === '"') {
              invEnd++;
              while (invEnd < n) {
                if (at(invEnd) === '\\') { invEnd += 2; continue; }
                if (at(invEnd) === '"') { invEnd++; break; }
                invEnd++;
              }
              continue;
            } else if (ch === "'") {
              invEnd++;
              while (invEnd < n) {
                if (at(invEnd) === '\\') { invEnd += 2; continue; }
                if (at(invEnd) === "'") { invEnd++; break; }
                invEnd++;
              }
              continue;
            }
            invEnd++;
          }
        }

        // Find the next non-whitespace token after the invocation.
        let nextIdx = invEnd;
        while (nextIdx < n && (at(nextIdx) === ' ' || at(nextIdx) === '\t' || at(nextIdx) === '\n' || at(nextIdx) === '\r')) nextIdx++;
        const nextTok = nextIdx < n ? at(nextIdx) : '';

        if (nextTok === ';' || nextTok === '{') {
          // Regular call (tree-sitter handles it) or the
          // MACRO(params) { body } pattern (handled by isMisparsedFunction).
          out.push(source.slice(i, invEnd));
          i = invEnd;
          continue;
        }

        // Statement-level macro → replace with `0;` + spaces.
        out.push(replaceWithSemicolon(source.slice(i, invEnd)));
        i = invEnd;
        continue;
      }

      // Not a known macro — copy the identifier through.
      out.push(ident);
      i = j;
      continue;
    }

    // Default — copy char verbatim.
    out.push(c);
    i++;
  }

  return out.join('');
}

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  macroTypes: ['preproc_def', 'preproc_function_def'],
  fieldTypes: ['field_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  preParse: preprocessStatementMacros,
  getReturnType: extractCppReturnType,
  isConst: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'type_qualifier' && c.text === 'const') return true;
    }
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return true;
    }
    return false;
  },
  isExported: (node) => {
    // C file-scope symbols have external linkage by default, internal with `static`
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return false;
    }
    return true;
  },
  isMisparsedFunction: (name, _node, macroNames) => {
    // C macros cause tree-sitter to misparse macro invocations as function
    // definitions when the shape matches NAME(params) { body }.
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    if (macroNames && macroNames.has(name)) return true;
    return false;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    // The inner enum_specifier/struct_specifier is anonymous, but we want the typedef name
    // to become the enum/struct node name.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes: #include <stdio.h>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  macroTypes: ['preproc_def', 'preproc_function_def'],
  fieldTypes: ['field_declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  preParse: preprocessStatementMacros,
  isConst: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'type_qualifier' && c.text === 'const') return true;
      if (c?.text === 'constexpr') return true;
    }
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return true;
    }
    return false;
  },
  isExported: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'storage_class_specifier' && c.text === 'static') return false;
    }
    return true;
  },
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getReturnType: extractCppReturnType,
  getVisibility: (node) => {
    // Check for access specifier in parent
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef: `typedef enum { ... } name;` or `typedef struct { ... } name;`
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name, _node, macroNames) => {
    // C++ macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause tree-sitter to misparse
    // namespace blocks as function_definitions (e.g. name = "namespace detail").
    // Also filter C++ keywords that tree-sitter occasionally misinterprets as
    // function/method names (e.g. switch statements inside macro-confused scopes).
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    // Filter out macro names that tree-sitter misparses as functions.
    // Tree-sitter C/C++ parsers lack a preprocessor: when a macro invocation
    // has the shape MACRO_NAME(params) { body }, it matches the
    // function_definition grammar rule and produces a spurious function node
    // for each call site (e.g. FOREACH_X creates 17 "functions" in OceanBase).
    if (macroNames && macroNames.has(name)) return true;
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes: #include <iostream>, #include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
