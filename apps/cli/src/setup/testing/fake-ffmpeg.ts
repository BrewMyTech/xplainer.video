/**
 * A scripted `ffmpeg` that answers `setup`'s four probe questions however a test needs it to.
 *
 * The provider's success path is proved against a **real** ffmpeg (`providers/ffmpeg.test.ts`,
 * over the loopback artefact server). What a real binary cannot supply on demand is each way one is
 * wrong — a libavcodec below the floor, no `libx264`, an experimental `aac`, a `-L` that contradicts
 * its own `-buildconf`, a binary that never answers — and those are refusals whose sentences matter.
 * So this writes a POSIX shell script that prints, for `-version`, `-buildconf`, `-L` and
 * `-encoders`, text in exactly the shape FFmpeg prints it, built from the options below.
 *
 * The licence statements are FFmpeg's own five texts (`fftools/opt_common.c`, `show_license`),
 * wrapped where FFmpeg wraps them, because the reader under test joins lines before it matches.
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What `-L` prints for each of FFmpeg's licence configurations. */
export const LICENCE_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
  "GPL-3.0-or-later": [
    "ffmpeg is free software; you can redistribute it and/or modify",
    "it under the terms of the GNU General Public License as published by",
    "the Free Software Foundation; either version 3 of the License, or",
    "(at your option) any later version.",
  ],
  "GPL-2.0-or-later": [
    "ffmpeg is free software; you can redistribute it and/or modify",
    "it under the terms of the GNU General Public License as published by",
    "the Free Software Foundation; either version 2 of the License, or",
    "(at your option) any later version.",
  ],
  "LGPL-3.0-or-later": [
    "ffmpeg is free software; you can redistribute it and/or modify",
    "it under the terms of the GNU Lesser General Public License as published by",
    "the Free Software Foundation; either version 3 of the License, or",
    "(at your option) any later version.",
  ],
  "LGPL-2.1-or-later": [
    "ffmpeg is free software; you can redistribute it and/or",
    "modify it under the terms of the GNU Lesser General Public",
    "License as published by the Free Software Foundation; either",
    "version 2.1 of the License, or (at your option) any later version.",
  ],
  nonfree: [
    "This version of ffmpeg has nonfree parts compiled in.",
    "Therefore it is not legally redistributable.",
  ],
};

/** The `configure` flags each configuration is made with, as `-buildconf` lists them. */
export const LICENCE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "GPL-3.0-or-later": ["--enable-gpl", "--enable-version3"],
  "GPL-2.0-or-later": ["--enable-gpl"],
  "LGPL-3.0-or-later": ["--enable-version3"],
  "LGPL-2.1-or-later": [],
  nonfree: ["--enable-gpl", "--enable-nonfree"],
};

/** The `-encoders` rows every render needs: libx264, and an `aac` that is not experimental. */
export const RENDER_ENCODERS: readonly string[] = [
  " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " A....D aac                  AAC (Advanced Audio Coding)",
];

/** How the script should answer. Every field defaults to an ffmpeg `setup` admits. */
export type FakeFfmpegOptions = {
  version?: string;
  /** `major.minor.micro`, printed as `-version` prints it. */
  libavcodec?: string;
  /** The configuration `-buildconf` and `-L` both describe. */
  licence?: string;
  /** A different configuration for `-buildconf` alone — a build whose two answers disagree. */
  buildconfLicence?: string;
  /** The listing's rows, after the `------` rule. */
  encoders?: readonly string[];
  /** Answer `-version` and then never answer anything else. */
  hangs?: boolean;
};

/** Write the script and its answers into `directory`, and return the script's path. */
export function writeFakeFfmpeg(directory: string, options: FakeFfmpegOptions = {}): string {
  mkdirSync(directory, { recursive: true });
  const version = options.version ?? "9.0.2";
  const [major, minor, micro] = (options.libavcodec ?? "63.1.102").split(".");
  const licence = options.licence ?? "GPL-2.0-or-later";
  const configured = options.buildconfLicence ?? licence;
  const flags = ["--prefix=/opt/fake", ...(LICENCE_FLAGS[configured] ?? []), "--enable-libx264"];
  const answers: Record<string, string> = {
    version: [
      `ffmpeg version ${version} Copyright (c) 2000-2026 the FFmpeg developers`,
      `configuration: ${flags.join(" ")}`,
      `libavutil      61.  1.102 / 61.  1.102`,
      `libavcodec     ${major}. ${minor?.padStart(2)}.${micro} / ${major}. ${minor?.padStart(2)}.${micro}`,
      "",
    ].join("\n"),
    buildconf: ["", "  configuration:", ...flags.map((flag) => `    ${flag}`), ""].join("\n"),
    license: [...(LICENCE_STATEMENTS[licence] ?? []), ""].join("\n"),
    encoders: [
      "Encoders:",
      " V..... = Video",
      " A..... = Audio",
      " ------",
      ...(options.encoders ?? RENDER_ENCODERS),
      "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(answers)) {
    writeFileSync(join(directory, `${name}.txt`), text);
  }
  const answer = (name: string): string => `cat '${join(directory, `${name}.txt`)}'`;
  const script = join(directory, "ffmpeg");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      // `$1` is `-hide_banner`, which the provider always passes first.
      'case "$2" in',
      `  -version) ${answer("version")} ;;`,
      `  -buildconf) ${options.hangs === true ? "exec sleep 30" : answer("buildconf")} ;;`,
      `  -L) ${answer("license")} ;;`,
      `  -encoders) ${answer("encoders")} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}
