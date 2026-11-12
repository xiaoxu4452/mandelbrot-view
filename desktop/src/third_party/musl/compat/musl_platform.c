/* COFF/CRT adapter: a couple of musl libm files reference __isnan, which the
 * MinGW math.h declares but the MSVC CRT spells _isnan.  This is the only
 * function here; every mathematical routine comes from musl itself.
 * compat/prefix.h renames __isnan to mbm___isnan at compile time, so this
 * single definition is the prefixed one musl's objects link against. */
int __isnan(double x) { return x != x; }
