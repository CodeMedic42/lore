import typescript from '@rollup/plugin-typescript'

export default {
  input: 'src/index.ts',
  output: [
    { dir: 'dist', format: 'esm', preserveModules: true, entryFileNames: '[name].mjs' },
    { dir: 'dist', format: 'cjs', preserveModules: true, entryFileNames: '[name].js' },
  ],
  external: ['react', 'react/jsx-runtime', 'classnames', 'date-fns'],
  plugins: [typescript({ tsconfig: './tsconfig.json' })],
}
