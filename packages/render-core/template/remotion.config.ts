/**
 * Shared render config for every explainer video.
 *
 * Tailwind is enabled workspace-wide so videos can use utility classes without
 * any per-video setup. Inline styles work equally well — pick per video, but
 * note that Tailwind *animation* classes never render in Remotion (see the
 * skill's motion notes); animate with interpolate() instead.
 */

import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig(enableTailwind);
