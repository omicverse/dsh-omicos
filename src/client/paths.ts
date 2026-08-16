/**
 * Path helpers shared by the client surfaces. Deliberately dependency-free
 * (no component imports): the tool card pulls in the host markdown
 * renderer, whose katex stylesheet cannot load in a node test env.
 */

/**
 * Make a workspace-relative path absolute when the owner told us the
 * session cwd.
 *
 * dsh's own `openFile` host handler resolves relative paths against the
 * session cwd, but a user with `dsh-better-sidebar` installed can route
 * chat file opens into ITS editor ("Open chat files in the sidebar"), and
 * that pipeline REQUIRES absolute — verified live: the same PDF answers
 * 400 "is not an absolute path" relative, 200 absolute. Absolute
 * satisfies both consumers.
 */
export function absolutize(path: string, cwd?: string): string {
  if (cwd === undefined || cwd === '' || path.startsWith('/')) return path
  return `${cwd.replace(/\/$/, '')}/${path}`
}
