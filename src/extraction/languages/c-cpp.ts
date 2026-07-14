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
 *   3. NOT inside an initializer list / aggregate body (braceStack top is
 *      not `true`) — excludes `NULL` in `{ NULL, 0 }`, `OB_X | 0x10` in
 *      `{ ... }`, macros in `enum E { A = MACRO }`, C++ `int x{ MACRO }`,
 *      `return { MACRO }`, etc.  Class/struct/namespace bodies are classified
 *      as `false` (allow replace) because they contain method bodies with
 *      statement-level macros and class-level macros like `TO_STRING_KV(...)`.
 *   4. NOT followed by `;` (no trailing semicolon → not a regular call;
 *      tree-sitter already handles those)
 *   5. NOT followed by `{` (preserves the existing isMisparsedFunction
 *      pattern `MACRO(params) { body }` — replacing it would break that
 *      mechanism)
 *   6. NOT followed by `,` (initializer-list element pattern — safety net
 *      for compound literals `(type){ MACRO, ... }` whose `{` was preceded
 *      by `)` and misclassified as a function body)
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
  // Brace context stack: true = initializer list / aggregate body (don't
  // replace macros), false = function body / statement block (replace OK).
  // Without this, macros like NULL inside `{ NULL, 0 }` initializer lists get
  // wrongly replaced with `0;` because parenDepth is 0 and the next token is
  // ',' (not ';' or '{'), producing illegal syntax that breaks tree-sitter.
  const braceStack: boolean[] = [];

  // Scan back over `out` to find the last non-whitespace character — used to
  // classify a `{` as function body (preceded by ')', ':', ';', '}') vs
  // initializer list (preceded by '=', ',', '(', identifier, etc.).
  const prevNonSpaceChar = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    return k >= 0 ? out[k]! : '';
  };
  // Scan back over `out` to find the last complete identifier token — used to
  // recognize keywords like `return`, `do`, `else`, `try` before a `{`.
  const prevWord = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    let end = k + 1;
    while (k >= 0 && isIdentPart(out[k]!)) k--;
    return out.slice(k + 1, end).join('');
  };
  // Scan back from the pending `{` to find the nearest `class`/`struct`/
  // `enum`/`namespace` keyword, skipping type names, inheritance (`: public
  // Base`), and template parameters (`<T, U>`).  Stops at statement boundaries
  // (`;`, `}`, `{`, `)`).  Used to classify `{` after a type name: a class/
  // struct/namespace body needs macro replacement (contains method bodies
  // with statement-level macros), while an enum body does not.
  const findTypeKeyword = (): string => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k]!)) k--;
    // Limit the backward scan to avoid O(n²) on large files — a type keyword
    // (class/struct/enum/namespace) always appears within a few hundred chars
    // of the `{` it introduces (type name + optional inheritance/templates).
    const limit = k - 512;
    while (k >= 0 && k > limit) {
      const ch = out[k]!;
      if (isIdentPart(ch)) {
        const end = k + 1;
        while (k >= 0 && isIdentPart(out[k]!)) k--;
        const word = out.slice(k + 1, end).join('');
        if (word === 'class' || word === 'struct' || word === 'enum' || word === 'namespace') {
          // `enum class Foo {` / `enum struct Foo {` are scoped enums — the
          // body is an enum body (enumerator initializers), not a class body.
          if (word === 'class' || word === 'struct') {
            let k2 = k;
            while (k2 >= 0 && /\s/.test(out[k2]!)) k2--;
            if (k2 >= 0 && isIdentPart(out[k2]!)) {
              const end2 = k2 + 1;
              while (k2 >= 0 && isIdentPart(out[k2]!)) k2--;
              if (out.slice(k2 + 1, end2).join('') === 'enum') return 'enum';
            }
          }
          return word;
        }
        // Not a type keyword — skip whitespace and continue scanning.
        while (k >= 0 && /\s/.test(out[k]!)) k--;
      } else if (ch === ';' || ch === '}' || ch === '{' || ch === ')') {
        return '';
      } else {
        k--;
      }
    }
    return '';
  };

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

    // Track brace context — classify each `{` as function body (false) or
    // initializer list / aggregate body (true).  This prevents macro
    // replacement inside `{ NULL, 0 }` etc. where parenDepth is 0 but the
    // context is NOT a statement context.
    if (c === '{') {
      const pc = prevNonSpaceChar();
      const pw = prevWord();
      const tk = findTypeKeyword();
      const isFuncBody = (pc === ')' || pc === ':' || pc === ';' || pc === '}') ||
                         (pw === 'do' || pw === 'else' || pw === 'try' || pw === 'finally') ||
                         (tk === 'class' || tk === 'struct' || tk === 'namespace');
      braceStack.push(!isFuncBody);
      out.push(c);
      i++;
      continue;
    }
    if (c === '}') {
      if (braceStack.length > 0) braceStack.pop();
      out.push(c);
      i++;
      continue;
    }

    // Identifier at depth 0 — candidate statement-level macro.
    const inNoReplace = braceStack.length > 0 && braceStack[braceStack.length - 1] === true;
    if (isIdentStart(c) && parenDepth === 0 && !inNoReplace) {
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
        if (nextTok === ',') {
          // Safety net: macro followed by ',' is an initializer-list element
          // pattern, not a statement-level macro.  This catches compound
          // literals `(type){ MACRO, ... }` whose `{` was preceded by ')' and
          // thus misclassified as a function body by braceStack.
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

/**
 * Decide whether a function-shaped AST node whose name matches a known
 * `#define` macro is a real function/declaration or a tree-sitter misparse of
 * a macro invocation `MACRO(args) { body }`.
 *
 * C permits a function and a `#define` macro to share a name (a common debug
 * wrapper pattern, e.g. `TlmDynamicMemAlloc`). The old name-only check
 * suppressed every such name, which dropped real function definitions and
 * declarations along with the misparse (regression in commit d96678f).
 *
 * The reliable witness is NESTING, not the `type` field: a macro invocation
 * misparse always appears INSIDE a function body (its direct parent is a
 * `compound_statement`), because macros are called in code, not at file scope.
 * A real function definition / prototype lives at `translation_unit` level (or
 * inside a class/struct `field_declaration_list`).
 *
 * Nesting is required because the e7ef006 form — a REAL function
 * `RRE_ATTR VOS_UINT32 foo(...) {}` that tree-sitter splits so the function
 * name lands in the `type` field and the declarator becomes a
 * `parenthesized_declarator` — is structurally identical to the
 * `FOREACH_X(items)\n{ body }` misparse. Both have type.text === name and a
 * parenthesized_declarator; only the parent (translation_unit vs
 * compound_statement) tells them apart, so a type-field check alone cannot.
 */
function cCppIsMacroInvocationMisparse(
  name: string,
  node: SyntaxNode,
  macroNames?: Set<string>
): boolean {
  if (!macroNames || !macroNames.has(name)) return false;
  // A macro invocation `MACRO(args) { body }` that tree-sitter misparses as a
  // function_definition / declaration always appears INSIDE a function body —
  // its direct parent is a `compound_statement`, because macros are invoked in
  // code, not at file scope. A real function definition / prototype lives at
  // the `translation_unit` level (or inside a class/struct
  // `field_declaration_list`).
  //
  // The parent check is what distinguishes the e7ef006 form — a REAL function
  // `RRE_ATTR VOS_UINT32 foo(...) {}` that tree-sitter splits so the function
  // name lands in the `type` field and the declarator becomes a
  // `parenthesized_declarator` — from the structurally identical
  // `FOREACH_X(items)\n{ body }` misparse. Both have type.text === name and a
  // parenthesized_declarator; only the nesting differs (translation_unit vs
  // compound_statement), so a type-field check alone cannot tell them apart.
  const parent = node.parent;
  if (parent && parent.type === 'compound_statement') return true;
  return false;
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
  isMisparsedFunction: (name, node, macroNames) => {
    // C macros cause tree-sitter to misparse macro invocations as function
    // definitions when the shape matches NAME(params) { body }.
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    if (cppKeywords.includes(name)) return true;
    return cCppIsMacroInvocationMisparse(name, node, macroNames);
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
  isMisparsedFunction: (name, node, macroNames) => {
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
    // The form check below keeps real functions that merely share a name with
    // a macro (C permits `void* foo(int);` alongside `#define foo(...)`).
    return cCppIsMacroInvocationMisparse(name, node, macroNames);
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
