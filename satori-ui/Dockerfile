# The dapp is a static bundle once built, so the runtime image is just nginx and
# a directory. The build stage is the heavy part and it stays here rather than on
# the server: react-scripts wants 1-2GB, and the box this deploys to has well
# under that free alongside everything else it runs.
#
# The REACT_APP_* values are compiled INTO the bundle, so they are build args and
# not runtime environment. A container built for one chain or indexer cannot be
# re-pointed at another by changing env vars later — rebuild instead. This is a
# property of Create React App, not a choice made here.
FROM node:20-slim AS build
WORKDIR /app

ARG REACT_APP_CHAIN_ID=8453
ARG REACT_APP_INDEXER_URL=
ARG REACT_APP_WALLETCONNECT_PROJECT_ID=
ENV REACT_APP_CHAIN_ID=$REACT_APP_CHAIN_ID \
    REACT_APP_INDEXER_URL=$REACT_APP_INDEXER_URL \
    REACT_APP_WALLETCONNECT_PROJECT_ID=$REACT_APP_WALLETCONNECT_PROJECT_ID \
    GENERATE_SOURCEMAP=false \
    CI=true

COPY package.json package-lock.json ./
RUN npm ci
# tailwind.config.js and postcss.config.js are NOT optional. Without
# postcss.config.js the build still SUCCEEDS and simply never runs Tailwind,
# emitting the handful of raw CSS rules from src instead of the generated
# utilities — a ~41KB stylesheet becomes ~2.5KB and every page renders with
# native browser styling. Nothing fails; you just get an unstyled site.
COPY tsconfig.json tailwind.config.js postcss.config.js ./
COPY public ./public
COPY src ./src
RUN npx react-scripts build

# Fail the build rather than ship an unstyled site. The failure above is silent
# by nature — exit code 0, assets present, correct filenames — so the only thing
# that catches it is checking the artifact is the size it ought to be.
RUN CSS=$(ls -S build/static/css/*.css 2>/dev/null | head -1); \
    SIZE=$(wc -c < "$CSS" 2>/dev/null || echo 0); \
    echo "largest stylesheet: ${CSS:-none} (${SIZE} bytes)"; \
    if [ "$SIZE" -lt 20000 ]; then \
      echo "ERROR: stylesheet is ${SIZE} bytes — Tailwind did not run."; \
      echo "       Expect ~40KB. Check that postcss.config.js and"; \
      echo "       tailwind.config.js were copied into the build stage."; \
      exit 1; \
    fi

# --- runtime: static files only. No node, no build tooling, nothing to exploit ---
FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
