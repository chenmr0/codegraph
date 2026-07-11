
UV_EXTERN int uv_check_init(uv_loop_t*, uv_check_t* check);
UV_EXTERN int uv_check_start(uv_check_t* check, uv_check_cb cb);
UV_EXTERN int uv_check_stop(uv_check_t* check);


struct uv_idle_s {
  UV_HANDLE_FIELDS
  UV_IDLE_PRIVATE_FIELDS
};

UV_EXTERN int uv_idle_init(uv_loop_t*, uv_idle_t* idle);
UV_EXTERN int uv_idle_start(uv_idle_t* idle, uv_idle_cb cb);
UV_EXTERN int uv_idle_stop(uv_idle_t* idle);


struct uv_async_s {
  UV_HANDLE_FIELDS
  UV_ASYNC_PRIVATE_FIELDS
};

UV_EXTERN int uv_async_init(uv_loop_t*,
                            uv_async_t* async,
                            uv_async_cb async_cb);
UV_EXTERN int uv_async_send(uv_async_t* async);


/*
 * uv_timer_t is a subclass of uv_handle_t.
 *
 * Used to get woken up at a specified time in the future.
 */
struct uv_timer_s {
  UV_HANDLE_FIELDS
  UV_TIMER_PRIVATE_FIELDS
};

UV_EXTERN int uv_timer_init(uv_loop_t*, uv_timer_t* handle);
UV_EXTERN int uv_timer_start(uv_timer_t* handle,
                             uv_timer_cb cb,
                             uint64_t timeout,
                             uint64_t repeat);
UV_EXTERN int uv_timer_stop(uv_timer_t* handle);
UV_EXTERN int uv_timer_again(uv_timer_t* handle);
UV_EXTERN void uv_timer_set_repeat(uv_timer_t* handle, uint64_t repeat);
UV_EXTERN uint64_t uv_timer_get_repeat(const uv_timer_t* handle);
UV_EXTERN uint64_t uv_timer_get_due_in(const uv_timer_t* handle);


/*
 * uv_getaddrinfo_t is a subclass of uv_req_t.
 *
 * Request object for uv_getaddrinfo.
 */
struct uv_getaddrinfo_s {
  UV_REQ_FIELDS
  /* read-only */
  uv_loop_t* loop;
  /* struct addrinfo* addrinfo is marked as private, but it really isn't. */
  UV_GETADDRINFO_PRIVATE_FIELDS
};


UV_EXTERN int uv_getaddrinfo(uv_loop_t* loop,
                             uv_getaddrinfo_t* req,
                             uv_getaddrinfo_cb getaddrinfo_cb,
                             const char* node,
                             const char* service,
                             const struct addrinfo* hints);
UV_EXTERN void uv_freeaddrinfo(struct addrinfo* ai);


/*
* uv_getnameinfo_t is a subclass of uv_req_t.
*
* Request object for uv_getnameinfo.
*/
struct uv_getnameinfo_s {
  UV_REQ_FIELDS
  /* read-only */
  uv_loop_t* loop;
  /* host and service are marked as private, but they really aren't. */
  UV_GETNAMEINFO_PRIVATE_FIELDS
};

UV_EXTERN int uv_getnameinfo(uv_loop_t* loop,
                             uv_getnameinfo_t* req,
                             uv_getnameinfo_cb getnameinfo_cb,
                             const struct sockaddr* addr,
                             int flags);


/* uv_spawn() options. */
typedef enum {
  UV_IGNORE         = 0x00,
  UV_CREATE_PIPE    = 0x01,
  UV_INHERIT_FD     = 0x02,
  UV_INHERIT_STREAM = 0x04,

  /*
   * When UV_CREATE_PIPE is specified, UV_READABLE_PIPE and UV_WRITABLE_PIPE
   * determine the direction of flow, from the child process' perspective. Both
   * flags may be specified to create a duplex data stream.
   */
  UV_READABLE_PIPE  = 0x10,
  UV_WRITABLE_PIPE  = 0x20,

  /*
   * When UV_CREATE_PIPE is specified, specifying UV_NONBLOCK_PIPE opens the
   * handle in non-blocking mode in the child. This may cause loss of data,
   * if the child is not designed to handle to encounter this mode,
   * but can also be significantly more efficient.
   */
  UV_NONBLOCK_PIPE  = 0x40,
  UV_OVERLAPPED_PIPE = 0x40 /* old name, for compatibility */
} uv_stdio_flags;

typedef struct uv_stdio_container_s {
  uv_stdio_flags flags;

  union {
    uv_stream_t* stream;
    int fd;
  } data;
} uv_stdio_container_t;

typedef struct uv_process_options_s {
  uv_exit_cb exit_cb; /* Called after the process exits. */
  const char* file;   /* Path to program to execute. */
  /*
   * Command line arguments. args[0] should be the path to the program. On
   * Windows this uses CreateProcess which concatenates the arguments into a
   * string this can cause some strange errors. See the note at
   * windows_verbatim_arguments.
   */
  char** args;
  /*
   * This will be set as the environ variable in the subprocess. If this is
   * NULL then the parents environ will be used.
   */
  char** env;
  /*
   * If non-null this represents a directory the subprocess should execute
   * in. Stands for current working directory.
   */
  const char* cwd;
  /*
   * Various flags that control how uv_spawn() behaves. See the definition of
   * `enum uv_process_flags` below.
   */
  unsigned int flags;
  /*
   * The `stdio` field points to an array of uv_stdio_container_t structs that
   * describe the file descriptors that will be made available to the child
   * process. The convention is that stdio[0] points to stdin, fd 1 is used for
   * stdout, and fd 2 is stderr.
   *
   * Note that on windows file descriptors greater than 2 are available to the
   * child process only if the child processes uses the MSVCRT runtime.
   */
  int stdio_count;
  uv_stdio_container_t* stdio;
  /*
   * Libuv can change the child process' user/group id. This happens only when
   * the appropriate bits are set in the flags fields. This is not supported on
   * windows; uv_spawn() will fail and set the error to UV_ENOTSUP.
   */
  uv_uid_t uid;
  uv_gid_t gid;
} uv_process_options_t;

/*
 * These are the flags that can be used for the uv_process_options.flags field.
 */
enum uv_process_flags {
  /*
   * Set the child process' user id. The user id is supplied in the `uid` field
   * of the options struct. This does not work on windows; setting this flag
   * will cause uv_spawn() to fail.
   */
  UV_PROCESS_SETUID = (1 << 0),
  /*
   * Set the child process' group id. The user id is supplied in the `gid`
   * field of the options struct. This does not work on windows; setting this
   * flag will cause uv_spawn() to fail.
   */
  UV_PROCESS_SETGID = (1 << 1),
  /*
   * Do not wrap any arguments in quotes, or perform any other escaping, when
   * converting the argument list into a command line string. This option is
   * only meaningful on Windows systems. On Unix it is silently ignored.
   */
  UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS = (1 << 2),
  /*
   * Spawn the child process in a detached state - this will make it a process
   * group leader, and will effectively enable the child to keep running after
   * the parent exits.  Note that the child process will still keep the
   * parent's event loop alive unless the parent process calls uv_unref() on
   * the child's process handle.
   */
  UV_PROCESS_DETACHED = (1 << 3),
  /*
   * Hide the subprocess window that would normally be created. This option is
   * only meaningful on Windows systems. On Unix it is silently ignored.
   */
  UV_PROCESS_WINDOWS_HIDE = (1 << 4),
  /*
   * Hide the subprocess console window that would normally be created. This
   * option is only meaningful on Windows systems. On Unix it is silently
   * ignored.
   */
  UV_PROCESS_WINDOWS_HIDE_CONSOLE = (1 << 5),
  /*
   * Hide the subprocess GUI window that would normally be created. This
   * option is only meaningful on Windows systems. On Unix it is silently
   * ignored.
   */
  UV_PROCESS_WINDOWS_HIDE_GUI = (1 << 6),
  /*
   * On Windows, if the path to the program to execute, specified in
   * uv_process_options_t's file field, has a directory component,
   * search for the exact file name before trying variants with
   * extensions like '.exe' or '.cmd'.
   */
  UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME = (1 << 7)
};

/*
 * uv_process_t is a subclass of uv_handle_t.
 */
struct uv_process_s {
  UV_HANDLE_FIELDS
  uv_exit_cb exit_cb;
  int pid;
  UV_PROCESS_PRIVATE_FIELDS
};

UV_EXTERN int uv_spawn(uv_loop_t* loop,
                       uv_process_t* handle,
                       const uv_process_options_t* options);
UV_EXTERN int uv_process_kill(uv_process_t*, int signum);
UV_EXTERN int uv_kill(int pid, int signum);
UV_EXTERN uv_pid_t uv_process_get_pid(const uv_process_t*);


/*
 * uv_work_t is a subclass of uv_req_t.
 */
struct uv_work_s {
  UV_REQ_FIELDS
  uv_loop_t* loop;
  uv_work_cb work_cb;
  uv_after_work_cb after_work_cb;
  UV_WORK_PRIVATE_FIELDS
};

UV_EXTERN int uv_queue_work(uv_loop_t* loop,
                            uv_work_t* req,
                            uv_work_cb work_cb,
                            uv_after_work_cb after_work_cb);

UV_EXTERN int uv_cancel(uv_req_t* req);


struct uv_cpu_times_s {
  uint64_t user; /* milliseconds */
  uint64_t nice; /* milliseconds */
  uint64_t sys; /* milliseconds */
  uint64_t idle; /* milliseconds */
  uint64_t irq; /* milliseconds */
};

struct uv_cpu_info_s {
  const char* model;
  int speed;
  struct uv_cpu_times_s cpu_times;
};

struct uv_interface_address_s {
  char* name;
  char phys_addr[6];
  int is_internal;
  union {
    struct sockaddr_in address4;
    struct sockaddr_in6 address6;
  } address;
  union {
    struct sockaddr_in netmask4;
    struct sockaddr_in6 netmask6;
  } netmask;
};

struct uv_passwd_s {
  char* username;
  unsigned long uid;
  unsigned long gid;
  char* shell;
  char* homedir;
};

struct uv_group_s {
  char* groupname;
  unsigned long gid;
  char** members;
};

struct uv_utsname_s {
  char sysname[256];
  char release[256];
  char version[256];
  char machine[256];
  /* This struct does not contain the nodename and domainname fields present in
     the utsname type. domainname is a GNU extension. Both fields are referred
     to as meaningless in the docs. */
};

struct uv_statfs_s {
  uint64_t f_type;
  uint64_t f_bsize;
  uint64_t f_blocks;
  uint64_t f_bfree;
  uint64_t f_bavail;
  uint64_t f_files;
  uint64_t f_ffree;
  uint64_t f_frsize;
  uint64_t f_spare[3];
};

typedef enum {
  UV_DIRENT_UNKNOWN,
  UV_DIRENT_FILE,
  UV_DIRENT_DIR,
  UV_DIRENT_LINK,
  UV_DIRENT_FIFO,
  UV_DIRENT_SOCKET,
  UV_DIRENT_CHAR,
  UV_DIRENT_BLOCK
} uv_dirent_type_t;

struct uv_dirent_s {
  const char* name;
  uv_dirent_type_t type;
};

UV_EXTERN char** uv_setup_args(int argc, char** argv);
UV_EXTERN int uv_get_process_title(char* buffer, size_t size);
UV_EXTERN int uv_set_process_title(const char* title);
UV_EXTERN int uv_resident_set_memory(size_t* rss);
UV_EXTERN int uv_uptime(double* uptime);
UV_EXTERN uv_os_fd_t uv_get_osfhandle(int fd);
UV_EXTERN int uv_open_osfhandle(uv_os_fd_t os_fd);

typedef struct {
   uv_timeval_t ru_utime; /* user CPU time used */
   uv_timeval_t ru_stime; /* system CPU time used */
   uint64_t ru_maxrss;    /* maximum resident set size */
   uint64_t ru_ixrss;     /* integral shared memory size */
   uint64_t ru_idrss;     /* integral unshared data size */
   uint64_t ru_isrss;     /* integral unshared stack size */
   uint64_t ru_minflt;    /* page reclaims (soft page faults) */
   uint64_t ru_majflt;    /* page faults (hard page faults) */
   uint64_t ru_nswap;     /* swaps */
   uint64_t ru_inblock;   /* block input operations */
   uint64_t ru_oublock;   /* block output operations */
   uint64_t ru_msgsnd;    /* IPC messages sent */
   uint64_t ru_msgrcv;    /* IPC messages received */
   uint64_t ru_nsignals;  /* signals received */
   uint64_t ru_nvcsw;     /* voluntary context switches */
   uint64_t ru_nivcsw;    /* involuntary context switches */
} uv_rusage_t;

UV_EXTERN int uv_getrusage(uv_rusage_t* rusage);
UV_EXTERN int uv_getrusage_thread(uv_rusage_t* rusage);

UV_EXTERN int uv_os_homedir(char* buffer, size_t* size);
UV_EXTERN int uv_os_tmpdir(char* buffer, size_t* size);
UV_EXTERN int uv_os_get_passwd(uv_passwd_t* pwd);
UV_EXTERN void uv_os_free_passwd(uv_passwd_t* pwd);
UV_EXTERN int uv_os_get_passwd2(uv_passwd_t* pwd, uv_uid_t uid);
UV_EXTERN int uv_os_get_group(uv_group_t* grp, uv_uid_t gid);
UV_EXTERN void uv_os_free_group(uv_group_t* grp);
UV_EXTERN uv_pid_t uv_os_getpid(void);
UV_EXTERN uv_pid_t uv_os_getppid(void);

#if defined(__PASE__)
/* On IBM i PASE, the highest process priority is -10 */
# define UV_PRIORITY_LOW 39          /* RUNPTY(99) */
# define UV_PRIORITY_BELOW_NORMAL 15 /* RUNPTY(50) */
# define UV_PRIORITY_NORMAL 0        /* RUNPTY(20) */
# define UV_PRIORITY_ABOVE_NORMAL -4 /* RUNTY(12) */
# define UV_PRIORITY_HIGH -7         /* RUNPTY(6) */
# define UV_PRIORITY_HIGHEST -10     /* RUNPTY(1) */
#else
# define UV_PRIORITY_LOW 19
# define UV_PRIORITY_BELOW_NORMAL 10
# define UV_PRIORITY_NORMAL 0
# define UV_PRIORITY_ABOVE_NORMAL -7
# define UV_PRIORITY_HIGH -14
# define UV_PRIORITY_HIGHEST -20
#endif

UV_EXTERN int uv_os_getpriority(uv_pid_t pid, int* priority);
UV_EXTERN int uv_os_setpriority(uv_pid_t pid, int priority);

enum {
  UV_THREAD_PRIORITY_HIGHEST = 2,
  UV_THREAD_PRIORITY_ABOVE_NORMAL = 1,
  UV_THREAD_PRIORITY_NORMAL = 0,
  UV_THREAD_PRIORITY_BELOW_NORMAL = -1,
  UV_THREAD_PRIORITY_LOWEST = -2,
};

UV_EXTERN int uv_thread_getpriority(uv_thread_t tid, int* priority);
UV_EXTERN int uv_thread_setpriority(uv_thread_t tid, int priority);

UV_EXTERN unsigned int uv_available_parallelism(void);
UV_EXTERN int uv_cpu_info(uv_cpu_info_t** cpu_infos, int* count);
UV_EXTERN void uv_free_cpu_info(uv_cpu_info_t* cpu_infos, int count);
UV_EXTERN int uv_cpumask_size(void);

UV_EXTERN int uv_interface_addresses(uv_interface_address_t** addresses,
                                     int* count);
UV_EXTERN void uv_free_interface_addresses(uv_interface_address_t* addresses,
                                           int count);

struct uv_env_item_s {
  char* name;
  char* value;
};

UV_EXTERN int uv_os_environ(uv_env_item_t** envitems, int* count);
UV_EXTERN void uv_os_free_environ(uv_env_item_t* envitems, int count);
UV_EXTERN int uv_os_getenv(const char* name, char* buffer, size_t* size);
UV_EXTERN int uv_os_setenv(const char* name, const char* value);
UV_EXTERN int uv_os_unsetenv(const char* name);

#ifdef MAXHOSTNAMELEN
# define UV_MAXHOSTNAMESIZE (MAXHOSTNAMELEN + 1)
#else
  /*
    Fallback for the maximum hostname size, including the null terminator. The
    Windows gethostname() documentation states that 256 bytes will always be
    large enough to hold the null-terminated hostname.
  */
# define UV_MAXHOSTNAMESIZE 256
#endif

UV_EXTERN int uv_os_gethostname(char* buffer, size_t* size);

UV_EXTERN int uv_os_uname(uv_utsname_t* buffer);

struct uv_metrics_s {
  uint64_t loop_count;
  uint64_t events;
  uint64_t events_waiting;
  /* private */
  uint64_t* reserved[13];
};

UV_EXTERN int uv_metrics_info(uv_loop_t* loop, uv_metrics_t* metrics);
UV_EXTERN uint64_t uv_metrics_idle_time(uv_loop_t* loop);

typedef enum {
  UV_FS_UNKNOWN = -1,
  UV_FS_CUSTOM,
  UV_FS_OPEN,
  UV_FS_CLOSE,
  UV_FS_READ,
  UV_FS_WRITE,
  UV_FS_SENDFILE,
  UV_FS_STAT,
  UV_FS_LSTAT,
  UV_FS_FSTAT,
  UV_FS_FTRUNCATE,
  UV_FS_UTIME,
  UV_FS_FUTIME,
  UV_FS_ACCESS,
  UV_FS_CHMOD,
  UV_FS_FCHMOD,
  UV_FS_FSYNC,
  UV_FS_FDATASYNC,
  UV_FS_UNLINK,
  UV_FS_RMDIR,
  UV_FS_MKDIR,
  UV_FS_MKDTEMP,
  UV_FS_RENAME,
  UV_FS_SCANDIR,
  UV_FS_LINK,
  UV_FS_SYMLINK,
  UV_FS_READLINK,
  UV_FS_CHOWN,
  UV_FS_FCHOWN,
  UV_FS_REALPATH,
  UV_FS_COPYFILE,
  UV_FS_LCHOWN,
  UV_FS_OPENDIR,
  UV_FS_READDIR,
  UV_FS_CLOSEDIR,
  UV_FS_STATFS,
  UV_FS_MKSTEMP,
  UV_FS_LUTIME
} uv_fs_type;
