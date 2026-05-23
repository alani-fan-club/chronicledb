const { resolve: pathResolveAbs, sep: pathSep } = require("path");

// Path-traversal guard: verify that a user-supplied filename, when joined to
// baseDir, stays inside baseDir. Rejects obvious traversal tokens up front and
// then confirms the resolved absolute path is a descendant of the resolved
// absolute base.
function safeResolveUnder(baseDir, userPath) {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("filename required");
  }
  if (userPath.includes("..") || userPath.includes("\0") || userPath.includes("/") || userPath.includes("\\")) {
    throw new Error(`unsafe filename: "${userPath}"`);
  }
  const absBase = pathResolveAbs(baseDir);
  const absFinal = pathResolveAbs(absBase, userPath);
  if (!absFinal.startsWith(absBase + pathSep) && absFinal !== absBase) {
    // Don't echo `absBase` to the caller — it's the resolved absolute
    // path under the ST data root and counts as host-internal info.
    throw new Error(`path traversal blocked: "${userPath}"`);
  }
  return absFinal;
}

module.exports = { safeResolveUnder };
