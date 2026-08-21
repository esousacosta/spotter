<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

All tests must pass before any commit is made in this repository.
<!-- END:nextjs-agent-rules -->

## Navigation & Links

**Never hardcode API URLs** (like `http://localhost:3000/api/...`). Instead:

1. **Client-side navigation**: Always use Next.js `Link` component or `useRouter()`:
   ```tsx
   import Link from 'next/link';
   <Link href="/trade-journal">Go to Trade Journal</Link>
   ```

2. **API calls**: Use relative paths in `fetch()` calls:
   ```tsx
   fetch('/api/trade-journal/list')  // ✓ Good
   fetch('http://localhost:3000/api/trade-journal/list')  // ✗ Bad
   ```

3. **Cross-page navigation buttons**: Add them to relevant pages so users don't need to know URLs:
   - Spotter page (`/`) → button to go to Trade Journal (`/trade-journal`)
   - Trade Journal (`/trade-journal`) → button to go back to Spotter (`/`)

4. **Avoid environment variable dependencies for navigation**: The app should work without users specifying `NEXTAUTH_URL` or similar for internal links. Use relative paths that work in any deployment.

