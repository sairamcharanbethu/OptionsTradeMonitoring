import { Snaptrade } from "snaptrade-typescript-sdk";
import fs from "fs";

const snaptrade = new Snaptrade({
  clientId: "PERS-8Q4PKK8U07RX1XSQM92Z",
  consumerKey: "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
});

async function main() {
  try {
    const userId = "sbethu";
    const userSecret = "264a905e-d75b-4f3b-939e-9c58f01c5375";

    console.log(`\nFetching accounts for user ${userId}...`);
    const accountsRes = await snaptrade.accountInformation.listUserAccounts({
      userId,
      userSecret,
    });
    const accounts = accountsRes.data.filter((account: any) => {
      const isStatusOpen = account.status?.toLowerCase() === "open" || account.meta?.status?.toLowerCase() === "open";
      const unifiedType = (account.meta?.unifiedAccountType || "").toLowerCase();
      const isSelfDirected = unifiedType.includes("self_directed") || unifiedType.includes("self directed");
      return isStatusOpen && isSelfDirected;
    });
    console.log(`Found ${accounts.length} open self-directed accounts`);
    
    // Write accounts to file for examination
    fs.writeFileSync("snaptrade_accounts.json", JSON.stringify(accounts, null, 2));

    const allPositions: Record<string, any> = {};
    for (const account of accounts) {
      console.log(`\nFetching positions for account ${account.id} (${account.name})...`);
      const positionsRes = await snaptrade.accountInformation.getUserAccountPositions({
        userId,
        userSecret,
        accountId: account.id,
      });
      allPositions[account.id] = positionsRes.data;
      console.log(`Found ${positionsRes.data.length || 0} positions for account ${account.id}`);
    }
    
    // Write positions to file for examination
    fs.writeFileSync("snaptrade_positions.json", JSON.stringify(allPositions, null, 2));
    console.log("\nData saved to snaptrade_accounts.json and snaptrade_positions.json");

  } catch (error: any) {
    console.error("Error connecting to SnapTrade:", error.message || error);
    if (error.response) {
      console.error(error.response.data);
    }
  }
}

main();
