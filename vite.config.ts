import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Runs the Vercel functions in /api inside the Vite dev server, so `pnpm dev` is the whole app.
function vercelApi(): Plugin {
	return {
		name: 'vercel-api',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (!req.url?.startsWith('/api/')) return next();
				try {
					const name = req.url.slice(5).split('?')[0];
					if (!/^[a-z-]+$/.test(name)) return next();
					const mod = await server.ssrLoadModule(`${server.config.root}/api/${name}.ts`);
					const handler = mod[req.method ?? 'GET'];
					if (!handler) return next();
					const chunks: Buffer[] = [];
					for await (const c of req) chunks.push(c as Buffer);
					const body = chunks.length ? Buffer.concat(chunks) : undefined;
					const r: Response = await handler(
						new Request(`http://localhost${req.url}`, { method: req.method, body, headers: req.headers as HeadersInit }),
					);
					res.statusCode = r.status;
					r.headers.forEach((v, k) => res.setHeader(k, v));
					res.end(Buffer.from(await r.arrayBuffer()));
				} catch (e) {
					res.statusCode = 500;
					res.end(JSON.stringify({ error: String(e) }));
				}
			});
		},
	};
}

export default defineConfig(({ mode }) => {
	Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
	return { plugins: [react(), vercelApi()], server: { port: 5291, strictPort: true } };
});
