// The ops scripts default to the Sepolia RPC and address book. Pointing RPC_URL at
// another chain while the book is still Sepolia's would send real transactions to
// the wrong deployment's addresses, so every script asks the node which chain it
// is on and refuses when the book names a different one.
async function requireChain(provider, book) {
  const chainId = Number((await provider.getNetwork()).chainId);
  if (book && book.chainId && Number(book.chainId) !== chainId) {
    throw new Error(
      `The address book is for chainId ${book.chainId} but the RPC answers chainId ${chainId}. ` +
      `Set RPC_URL and ADDRESS_BOOK (or NETWORK) for the same chain.`);
  }
  return chainId;
}

module.exports = { requireChain };
