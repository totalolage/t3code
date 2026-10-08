/**
 * The standalone builder replaces this map with imports for the web build.
 *
 * Values are paths returned by Bun's `file` loader; keeping the source empty
 * lets the regular Node development and package builds use their existing
 * static-directory discovery.
 */
export const embeddedWebAssets: Readonly<Record<string, string>> = {};
