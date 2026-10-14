# Satori Development Standards

## Daily Development Workflow

### ✅ REQUIRED: Start Every Session With This

```bash
cd /app/satori
./scripts/reset-local-dev.sh
```

**This is NOT optional.** This script prevents the #1 most common issue: "streams not showing in UI."

### Why This Matters

Every time Hardhat node restarts, contracts deploy to **new addresses**. The UI must be updated with these addresses or it will fail silently.

**The reset script:**
1. Ensures fresh blockchain state
2. Deploys contracts
3. **Automatically updates UI config** ← Critical
4. Seeds test data
5. Verifies setup

**Time:** 30 seconds
**Manual alternative:** 5-10 minutes + high error rate

---

## Contract Address Management

### The Problem

```
Hardhat Restart → New Address → UI Still Has Old Address → Nothing Works
```

### The Solution

**ALWAYS use the automated script.** Never manually restart Hardhat without updating the UI.

### Manual Update (Emergency Only)

If the script fails:

1. Deploy: `npx hardhat run scripts/deploy.js --network localhost`
2. Copy Satori address from output
3. Edit: `/app/satori-ui/src/contracts/addresses.ts`
4. Find your chain ID (1337 or 31337)
5. Update SATORI address
6. Seed: `CONTRACT_ADDRESS=<addr> npx hardhat run scripts/seed-dev-data.js --network localhost`

---

## Git Workflow

### Before Committing

```bash
# 1. Run tests
cd /app/satori
npx hardhat test

# Expected: 363 passing

# 2. Check UI compiles
cd /app/satori-ui
npm run build

# 3. Verify contract addresses are NOT hardcoded to localhost addresses
grep "0x7969c5eD335650692Bc04293B07F5BF2e7A673C0" src/contracts/addresses.ts
# This should NOT appear in production config (only in 1337/31337)
```

### Commit Messages

Follow conventional commits:

```
feat: Add new stream type support
fix: Resolve contract address sync issue
docs: Update local development guide
test: Add multi-user delegation tests
```

---

## Testing Standards

### Required Before Merge

- ✅ All 363 tests passing
- ✅ No new TypeScript errors
- ✅ No new console warnings
- ✅ UI builds without errors
- ✅ Manual smoke test (create stream, vote, predict)

### Adding New Tests

1. Place in appropriate file under `/app/satori/test/`
2. Follow existing test patterns
3. Use descriptive test names
4. Add comments for complex scenarios
5. Verify test passes in isolation: `npx hardhat test --grep "your test name"`

---

## Code Style

### Solidity

```solidity
// ✅ Good
function createStream(string memory name, address authority) external returns (uint32) {
    require(bytes(name).length > 0, "Name required");
    // ... implementation
}

// ❌ Bad
function createStream(string memory name,address authority)external returns(uint32){
    require(bytes(name).length>0,"Name required");
    // ... implementation
}
```

**Standards:**
- 4-space indentation
- Clear variable names
- Comments for complex logic
- NatSpec documentation for public functions

### TypeScript/React

```typescript
// ✅ Good
export function StreamVoting() {
  const { streams, loading } = useStreams();

  if (loading) return <LoadingSpinner />;

  return (
    <div className="stream-list">
      {streams.map(stream => (
        <StreamCard key={stream.id} stream={stream} />
      ))}
    </div>
  );
}

// ❌ Bad
export function StreamVoting(){
const{streams,loading}=useStreams();
if(loading)return <LoadingSpinner/>
return <div className="stream-list">{streams.map(stream=><StreamCard key={stream.id} stream={stream}/>)}</div>
}
```

**Standards:**
- 2-space indentation for TS/React
- Destructure hook returns
- Early returns for loading/error states
- Descriptive component names

---

## Documentation Standards

### When to Update Docs

Update documentation when you:
- Add a new feature
- Change existing behavior
- Fix a recurring bug
- Add a new script
- Change the development workflow

### Documentation Locations

- `/app/docs/how/` - How-to guides
- `/app/docs/development/` - Development guides
- `/app/satori/README.md` - Contract overview
- `/app/satori-ui/README.md` - UI overview
- Inline code comments - Complex logic

---

## Common Mistakes to Avoid

### ❌ DON'T

1. **Manually restart Hardhat** without updating UI config
2. **Skip the reset script** ("I'll just be quick")
3. **Commit localhost addresses** to production config
4. **Modify contracts** without updating tests
5. **Push failing tests** ("I'll fix it later")
6. **Use console.log** for debugging without removing
7. **Hardcode values** that should be configurable
8. **Skip documentation** for new features

### ✅ DO

1. **Always use** `./scripts/reset-local-dev.sh`
2. **Run tests** before committing
3. **Update docs** when changing behavior
4. **Ask questions** if unsure
5. **Follow existing patterns** in the codebase
6. **Write descriptive commit messages**
7. **Test manually** after code changes
8. **Keep PRs focused** on single issues

---

## Debugging Checklist

### "Streams not showing"

1. ✅ Run `./scripts/reset-local-dev.sh`
2. ✅ Check chain ID: `curl -X POST http://localhost:8545 -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'`
3. ✅ Verify UI address matches: `grep SATORI /app/satori-ui/src/contracts/addresses.ts`
4. ✅ Check streams exist: `npx hardhat run scripts/verify-contract-state.js --network localhost`
5. ✅ Check browser console for errors
6. ✅ Hard refresh (Ctrl+Shift+R)

### "Contract call failed"

1. ✅ Check MetaMask is connected to Localhost 8545
2. ✅ Check chain ID matches (1337 or 31337)
3. ✅ Check account has tokens: `npx hardhat run scripts/check-balances.js --network localhost`
4. ✅ Check function exists in contract ABI
5. ✅ Check Hardhat node logs: `tail -50 /tmp/hardhat-node.log`

### "Tests failing"

1. ✅ Clean install: `rm -rf node_modules && npm install`
2. ✅ Recompile: `npx hardhat clean && npx hardhat compile`
3. ✅ Run single test: `npx hardhat test --grep "test name"`
4. ✅ Check for async issues (missing await)
5. ✅ Check for state pollution (tests affecting each other)

---

## Emergency Contacts

**Before asking for help:**
1. ✅ Read error message completely
2. ✅ Check relevant documentation in `/app/docs/how/`
3. ✅ Search codebase for similar patterns
4. ✅ Try the automated reset script
5. ✅ Check recent commits for related changes

**When asking for help, include:**
- What you were trying to do
- What you expected to happen
- What actually happened
- Error messages (complete, not truncated)
- Steps you've already tried

---

## Tools and Extensions (Recommended)

### VS Code Extensions
- Solidity (Juan Blanco)
- ESLint
- Prettier
- GitLens
- Error Lens

### Browser Extensions
- MetaMask
- React Developer Tools
- Redux DevTools (if using Redux)

---

## Performance Standards

### Contract Gas Limits
- Single transaction: < 30M gas
- Average operation: < 200k gas
- View functions: < 50k gas

### UI Performance
- Initial load: < 3 seconds
- Contract call: < 2 seconds
- Page transition: < 500ms

---

## Security Standards

### Contract Security
- ✅ No tx.origin usage
- ✅ All external calls use try/catch
- ✅ Reentrancy guards on state changes
- ✅ Access control on sensitive functions
- ✅ Input validation on all functions

### UI Security
- ✅ No private keys in code
- ✅ Validate all user input
- ✅ Sanitize displayed data
- ✅ Use prepared statements for queries
- ✅ HTTPS in production

---

## Release Checklist

Before deploying to testnet/mainnet:

- [ ] All tests passing (363/363)
- [ ] UI builds without errors/warnings
- [ ] Test mode toggle REMOVED
- [ ] Contract addresses updated for target network
- [ ] Gas usage reviewed and optimized
- [ ] Security audit completed (for mainnet)
- [ ] Documentation updated
- [ ] Deployment plan reviewed
- [ ] Rollback plan prepared
- [ ] Team notified

---

**Last Updated:** 2025-11-16
**Maintainer:** Development Team
**Questions:** See `/app/docs/how/` or ask in team chat
