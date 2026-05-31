import fs from 'fs';

const accounts = JSON.parse(fs.readFileSync('snaptrade_accounts.json', 'utf8'));

const filteredAccounts = accounts.filter((account: any) => {
  const meta = account.meta || {};
  // Wealthsimple accounts might have status at root or in meta
  const rootStatus = (account.status || "").toLowerCase();
  const metaStatus = (meta.status || "").toLowerCase();
  const isStatusOpen = rootStatus === "active" || rootStatus === "open" || metaStatus === "open";
  
  const unifiedAccountType = (meta.unifiedAccountType || "").toLowerCase();
  const isSelfDirected = unifiedAccountType.includes("self_directed") || unifiedAccountType.includes("self directed");

  return isStatusOpen && isSelfDirected;
});

console.log(`Original accounts: ${accounts.length}`);
console.log(`Filtered accounts: ${filteredAccounts.length}`);

filteredAccounts.forEach((account: any) => {
  console.log(`\nAccount ID: ${account.id}`);
  console.log(`Name: ${account.name}`);
  console.log(`Root Status: ${account.status}`);
  console.log(`Meta Status: ${account.meta?.status}`);
  console.log(`Unified Account Type: ${account.meta?.unifiedAccountType}`);
});
