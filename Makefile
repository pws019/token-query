build-HonoApiFunction:
	CI=true pnpm install --frozen-lockfile
	pnpm --filter server build
	mkdir -p $(ARTIFACTS_DIR)
	cp apps/server/dist/*.mjs $(ARTIFACTS_DIR)/
