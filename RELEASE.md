# Release

Run `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test && SAM_LIVE=1 pnpm test && pnpm run build`, verify `npm pack`, then publish via GitHub Release.
