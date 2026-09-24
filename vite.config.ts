import { defineConfig } from 'vite'

export default defineConfig({
  // 5175: Ollama on G2 owns 5173 and FightNight 5174 on this machine.
  server: { host: true, port: 5175, strictPort: true },
  build: { target: 'esnext' },
})
