"""Turn `dumpbin /exports OpenCL.dll` output into a module-definition file.

The shipped Windows ICD is the Khronos loader itself, so its export table is
the authoritative list of every OpenCL entry point this machine can call.
Generating the import library from it (instead of copying a vendor SDK) keeps
the checked-in .lib exact for the target ABI and costs a few kilobytes.
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
row = re.compile(r"^\s*\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$")
names = []
for line in open(src, encoding="utf-8", errors="replace"):
    m = row.match(line)
    if m and (m.group(1).startswith("cl") or m.group(1).startswith("clIcd")):
        names.append(m.group(1))
if not names:
    raise SystemExit("no OpenCL exports parsed from " + src)
names = sorted(set(names))
with open(dst, "w", encoding="ascii", newline="\n") as f:
    f.write("LIBRARY OpenCL.dll\nEXPORTS\n")
    for n in names:
        f.write("    " + n + "\n")
print(f"{len(names)} OpenCL exports -> {dst}")
