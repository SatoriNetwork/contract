# No build stage: plain node, one dependency, no native modules.
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# /data holds ledger + proposal proofs; owned by the unprivileged user so
# named volumes inherit writable permissions on first use.
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8788
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
