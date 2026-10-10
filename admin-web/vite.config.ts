import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 经网关 /mp 挂载时剥掉 /mp 前缀, 直连时就是 /admin/*:
// 资源用相对路径（文档在 /mp/admin/ 下时解析为 /mp/admin/assets/...，
// 直连 /admin/ 下时解析为 /admin/assets/...），两种形态都成立。
// 注意：必须用 HashRouter（history 路由的深层 URL 会带偏相对解析）。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      "/admin/api": "http://127.0.0.1:18091",
    },
  },
});
