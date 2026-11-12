#ifndef MB_MUSL_ENDIAN_H
#define MB_MUSL_ENDIAN_H
/* Windows/COFF platform adapter for musl's libm.h.  Only the byte-order
 * macros and byte-swap helpers that libm.h actually uses are needed; the
 * uint types come from the toolchain's <stdint.h> so LP64/LLP64 stays right. */
#include <stdint.h>
#define __LITTLE_ENDIAN 1234
#define __BIG_ENDIAN    4321
#define __PDP_ENDIAN    3412
#define __BYTE_ORDER    __LITTLE_ENDIAN
#define LITTLE_ENDIAN   __LITTLE_ENDIAN
#define BIG_ENDIAN      __BIG_ENDIAN
#define PDP_ENDIAN      __PDP_ENDIAN
#define BYTE_ORDER      __BYTE_ORDER
static __inline uint16_t __bswap16(uint16_t x) { return (uint16_t)(x << 8 | x >> 8); }
static __inline uint32_t __bswap32(uint32_t x) {
  return x >> 24 | x >> 8 & 0xff00 | x << 8 & 0xff0000 | x << 24;
}
static __inline uint64_t __bswap64(uint64_t x) {
  return (uint64_t)__bswap32((uint32_t)x) << 32 | __bswap32((uint32_t)(x >> 32));
}
#endif
