// The package's ESM entry uses extensionless imports that plain Node can't
// resolve, so core imports the bundled build, which ships without types.
declare module 'quickhull3d/dist/quickhull3d.js' {
  export default function quickhull(points: ArrayLike<number>[], options?: { skipTriangulation?: boolean }): number[][]
}
