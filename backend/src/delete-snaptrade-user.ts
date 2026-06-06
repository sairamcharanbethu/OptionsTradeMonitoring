import { Snaptrade } from "snaptrade-typescript-sdk";

const snaptrade = new Snaptrade({
  clientId: "PERS-8Q4PKK8U07RX1XSQM92Z",
  consumerKey: "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
});

async function main() {
  try {
    const userId = "sbethu";
    console.log(`Deleting user: ${userId}...`);
    
    await snaptrade.authentication.deleteSnapTradeUser({
      userId
    });
    console.log("User deleted.");
    
  } catch (error: any) {
    console.error("Error deleting user:", error.message || error);
    if (error.response) {
      console.error(error.response.data);
    }
  }
}

main();
