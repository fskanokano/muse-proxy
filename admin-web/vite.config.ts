import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 经网关 /mp 挂载时剥掉 /mp 前缀, 直连时就是 /admin/*:
// base 取 /admin/, 内部 API 一律相对路径, 两种访问形态都成立。
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      "/admin/api": "http://127.0.0.1:18091",
    },
  },
});
