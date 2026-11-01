import { defineConfig } from 'vite';

// 相対パスで出力し、GitHub Pages（/historyconnect/）でもローカルでも動くようにする
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
