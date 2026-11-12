#ifndef MB_MUSL_FEATURES_H
#define MB_MUSL_FEATURES_H
/* Alias machinery is not needed when every public symbol is prefixed at
 * compile time; emitting weak aliases would only create duplicate names. */
#define weak_alias(old, new)
#define hidden
#endif
