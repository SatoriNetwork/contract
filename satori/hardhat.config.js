require("@nomicfoundation/hardhat-toolbox");
require("solidity-coverage");
require("hardhat-gas-reporter");
// Loads .env from the repo root (this config lives one level down, in satori/).
// See .env.example for the keys. Absent .env, every network below simply has no
// accounts and local/test work is unaffected.
// `quiet` suppresses dotenv's startup banner, which otherwise prints on every
// hardhat invocation including each test run.
require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
  quiet: true
});

// A deploy key is only needed for the live networks. Missing/blank => no
// accounts, so `--network baseSepolia` fails with a clear "no signer" rather
// than a confusing hex-parse error at config load.
const DEPLOY_KEY = (process.env.PRIVATE_KEY || "").trim();
const ACCOUNTS = /^0x[0-9a-fA-F]{64}$/.test(DEPLOY_KEY) ? [DEPLOY_KEY] : [];

// Shared compiler settings. Kept identical across compiler versions so the
// monolith's bytecode/gas are unaffected by the restructure's newer-solc files.
const SOLC_SETTINGS = {
  viaIR: true, // bounty refactor: IR pipeline reduces SatoriRewards bytecode
               // below the 24,576-byte EIP-170 ceiling.
  optimizer: {
    enabled: true,
    runs: 1  // Minimum deployment size (trades runtime gas for smaller bytecode)
  },
  // Strip the trailing IPFS metadata hash (~51 bytes) from the deployed
  // bytecode — pure size reclaim, no behavioural change. Helps Satori.sol
  // stay under the 24,576-byte EIP-170 ceiling.
  metadata: { bytecodeHash: "none" },
  evmVersion: "paris",
  // Emit per-contract storage layouts (merged with Hardhat's default abi/
  // bytecode outputs) so storage-layout tests can machine-check layouts.
  outputSelection: { "*": { "*": ["storageLayout"] } }
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    // Monolith + children compile on 0.8.20 (unchanged). The restructure's
    // UUPS engine needs OZ 5.4 proxy code (^0.8.22), so it compiles on 0.8.24
    // via the override below — same settings, same paris target, so it
    // interoperates with the 0.8.20 contracts and leaves them byte-identical.
    compilers: [
      { version: "0.8.20", settings: SOLC_SETTINGS },
    ]
  },

  networks: {
    hardhat: {
      // 31337 is Hardhat's own default and what the dapp's addresses.ts keys its
      // local address book on (DEV_CHAIN_ID). The previous 1337 override meant a
      // locally-run node reported a chain the UI had no addresses for, so the dapp
      // threw "No addresses for chain 1337" and local dev could not connect.
      chainId: 31337,
      allowUnlimitedContractSize: true,
      mining: {
        auto: true,
        interval: 0
      }
    },
    localhost: {
      // The dapp derives its RPC URL as (its own port + 1) — devRpcUrl() in
      // satori-ui/src/contracts/addresses.ts — and run-local.sh defaults the UI
      // to 3032, so the node listens on 3033. This previously said 3032, which
      // is the UI's own port: `--network localhost` talked to the web server
      // instead of the chain unless HARDHAT_URL was set by hand.
      // Override with HARDHAT_URL if you moved UI_PORT.
      url: process.env.HARDHAT_URL || "http://127.0.0.1:3033",
      chainId: 31337
    },

    // Base Sepolia — the rehearsal target. Base because the dapp pins
    // PROD_CHAIN_ID = 8453 (satori-ui/src/contracts/addresses.ts), so this is the
    // testnet that matches where Satori actually ships. The default RPC is
    // Base's own public endpoint; it is rate-limited, so set BASE_SEPOLIA_RPC_URL
    // to a provider endpoint for a real deploy run.
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: ACCOUNTS,
      // A full deploy is ~40 sequential transactions. On 2026-08-21 one of them
      // failed with "replacement transaction underpriced" partway through the
      // wiring block, stranding a half-wired stack. (deploy.js now adopts the
      // token on a rerun: setController and setHook can be set again until
      // frozen.)
      //
      // That error means a SECOND transaction was submitted on a nonce the RPC
      // still had in flight — the same read-after-write lag `live-reads-lib.js`
      // exists for, except here it is the nonce that lags a confirmed receipt
      // rather than a contract read. A provider endpoint load-balancing across
      // nodes with different mempool views produces exactly this.
      //
      // Pinning the price does not fix the lag, but it makes a same-nonce
      // resubmission a genuine REPLACEMENT (same price, deterministically
      // rejected) rather than a race decided by whichever node answered, and it
      // keeps every transaction well clear of the ~0.006 gwei base fee where
      // ties are most likely. Costs nothing on a testnet.
      gasPrice: Number(process.env.DEPLOY_GAS_PRICE_WEI || 100000000), // 0.1 gwei
    },

    // Base mainnet. Present so the deploy/verify tooling is identical to the
    // rehearsal — NOT because anything should be deployed here yet. One address
    // slot is IRREVERSIBLE: PLATFORM_FEE_RECIPIENT is immutable on SatoriToken,
    // which has no upgrade path at all, so it has exactly one chance to be right.
    // (MARKETING_FEE_RECIPIENT used to be a second such slot; it now lives in
    // rewards proxy storage and the recipient can rotate it two-step.)
    // See docs/LAUNCH_CHECKLIST.md section C before ever running this.
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      timeout: 300000,
      chainId: 8453,
      accounts: ACCOUNTS,
      // Same pin and reason as baseSepolia. 0.1 gwei is far above Base's usual
      // base fee; raise DEPLOY_GAS_PRICE_WEI if it ever is not.
      gasPrice: Number(process.env.DEPLOY_GAS_PRICE_WEI || 100000000),
    },

    // ---------------------------------------------------------------------
    // Superchain chains — REMOTE, BRIDGE-ONLY SATORI ONLY.
    //
    // Never run scripts/deploy.js against these. That script builds the full
    // playable stack, and there is exactly one game, on Base. The scripts that
    // belong here are scripts/deploy-remote-token.js, which deploys the token
    // alone at the same CREATE2 address, with every emission path closed by the
    // token's own HOME_CHAIN_ID gate, and scripts/deploy-safe.js, which creates
    // the root Safe at the same address so the copy's slots have an owner.
    //
    // Public endpoints are defaults so a dry run needs no setup; they are
    // rate-limited, so set the matching *_RPC_URL for a real deploy.
    //
    // Chain ids are asserted by hardhat against the endpoint on connect, so a
    // wrong value here fails loudly at startup rather than deploying somewhere
    // unexpected. Interop had not shipped to mainnet as of 2026-08, so a token
    // deployed here is correct but DORMANT until it does.
    //
    // ⚠️ WHICH CHAINS ARE ACTUALLY ON THE INTEROP TRACK. The Karst hardfork
    // (2026-07-08) is a prerequisite for interop, and its mainnet list is:
    //   op, ink, zora, mode, lisk, metal, unichain, soneium, ethernity, tbn
    // Note who is NOT on it: **Base** (which announced in Feb 2026 that it is
    // leaving the OP Stack) and **World Chain**. Being on this list is not a
    // guarantee of interop and being absent is not proof of refusal, but deploy
    // decisions should follow the list rather than "is it a Superchain chain".
    // This is exactly why the token carries a tier-2 transport lane — see
    // docs/design/superchain-native-token.md §2.
    // ---------------------------------------------------------------------
    optimism: {
      url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
      chainId: 10,
      accounts: ACCOUNTS
    },
    unichain: {
      url: process.env.UNICHAIN_RPC_URL || "https://mainnet.unichain.org",
      chainId: 130,
      accounts: ACCOUNTS
    },
    soneium: {
      url: process.env.SONEIUM_RPC_URL || "https://rpc.soneium.org",
      chainId: 1868,
      accounts: ACCOUNTS
    },
    lisk: {
      url: process.env.LISK_RPC_URL || "https://rpc.api.lisk.com",
      chainId: 1135,
      accounts: ACCOUNTS
    },
    // NOT on the Karst list. Kept because World Chain's verified-human user base
    // is strategically interesting, but treat its interop future as unknown and
    // do not deploy here expecting a working lane.
    worldchain: {
      url: process.env.WORLDCHAIN_RPC_URL || "https://worldchain-mainnet.g.alchemy.com/public",
      chainId: 480,
      accounts: ACCOUNTS
    },
    ink: {
      url: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",
      chainId: 57073,
      accounts: ACCOUNTS
    },
    mode: {
      url: process.env.MODE_RPC_URL || "https://mainnet.mode.network",
      chainId: 34443,
      accounts: ACCOUNTS
    },
    zora: {
      url: process.env.ZORA_RPC_URL || "https://rpc.zora.energy",
      chainId: 7777777,
      accounts: ACCOUNTS
    },

    // OP Sepolia — the live second testnet the rehearsal decision calls for
    // (Supersim + Base Sepolia + one real remote chain). This is where the
    // identical-address property gets proven on an actual chain rather than a
    // simulator, before any of the mainnets above are touched.
    opSepolia: {
      url: process.env.OP_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts: ACCOUNTS
    }
  },

  // Contract verification. hardhat-verify (via toolbox) knows both chains
  // natively, so only the key is needed:
  //   npx hardhat verify --network baseSepolia <address> <constructor args>
  // Etherscan V2 takes ONE key across every chain it covers (it routes on a
  // chainid parameter), which is why this is a bare string rather than the old
  // per-chain map. Set ETHERSCAN_API_KEY; BASESCAN_API_KEY is still honoured so
  // existing local .env files keep working.
  //
  // NOT every Superchain chain is on Etherscan — several run Blockscout, which
  // needs its own verify step and no key. Check per chain before assuming a
  // verify will land. Tracked in docs/design/superchain-native-token.md.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || ""
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },

  mocha: {
    timeout: 40000 // 40 seconds for time-based tests
    // (The old predictLogicSetup rootHook that installed the SatoriPredictLogic
    //  delegatecall module at a fixed address is gone with the restructure — the
    //  SatoriEngine is a normal UUPS contract, no vanity-address delegatecall.)
  }
};
