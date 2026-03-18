import { createRequest, sendResponse } from '@remix-run/node-fetch-server'
import { defineConfig } from 'vite'

export default defineConfig({
  define: {
    'process.env': '{}',
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  plugins: [
    {
      name: 'api',
      async configureServer(server) {
        const { handler } = await import('./src/server.ts')
        server.middlewares.use(async (req, res, next) => {
          const request = createRequest(req, res)
          const response = await handler(request)
          if (response) await sendResponse(res, response)
          else next()
        })
        server.httpServer?.once('listening', () => {
          const addr = server.httpServer!.address()
          const host =
            typeof addr === 'object' && addr ? `localhost:${addr.port}` : 'localhost:5173'
          console.log(`\n  Solana MPP charge example running at http://${host}\n`)
        })
      },
    },
  ],
})
