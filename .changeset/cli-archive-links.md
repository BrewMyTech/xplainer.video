---
"@xplainer/cli": patch
---

`xplainer setup`'s archive readers refuse three more shapes of archive. The zip reader refuses a
member whose path passes through a symlink an earlier member made — a chain of links that each
land inside the tree could otherwise put a file outside it — and a link whose value is not in
normal form, such as `l/..`. It also judges "two members on one path" by asking the filesystem, so
`bin/ffmpeg` and `BIN/FFMPEG` are refused on a case-insensitive APFS or NTFS volume instead of the
second replacing the first. The tar reader reads a name prefix only from a POSIX ustar header, and
no longer from a GNU one, where those bytes are timestamps. No artefact the committed manifest pins
is affected: none carries a symlink, a case collision or a prefix.
