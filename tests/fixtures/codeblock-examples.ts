// SPDX-License-Identifier: LGPL-3.0-only
/** Exact user-message sources, read from the native records behind issue 2.68. */
const path =
  "/home/user/Documents/InterActive/previews/preview-qt612-scroll-20261119-2144/run-playground";
export const permissionSource =
  `playground -rwxr-xr-x 1 user user 490 Nov 19 21:45 ${path}`;
export const codeblockExamples = [
  'TL;DR: Ark sent the files as executable. The laptop\'s Syncthing is most likely set to ignore permissions for ~/Documents, so they arrived without the executable bit.\n\nI told you I ran "chmod" on it, and even showed you permissions for the fiile:\n\n```\n' +
  permissionSource + "\n```",
  `$ ~/Documents/InterActive/previews/preview-qt612-scroll-20261119-2144/run-playground\n${path}: line 12: /home/user/Documents/InterActive/previews/preview-qt612-scroll-20261119-2144/bin/interactive-playground: Permission denied\n\`\`\`\n\n\`\`\`\n$ ls -la ~/Documents/InterActive/previews/preview-qt612-scroll-20261119-2144/run-playground\n-rwxr-xr-x 1 user user 490 Nov 19 21:45 ${path}\n\`\`\``,
];
