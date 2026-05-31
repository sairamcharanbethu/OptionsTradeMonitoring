import { Snaptrade } from "snaptrade-typescript-sdk";

const snaptrade = new Snaptrade({
  clientId: "PERS-8Q4PKK8U07RX1XSQM92Z",
  consumerKey: "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
});

async function main() {
  try {
    const userId = "sbethu";
    console.log(`Resetting secret for user: ${userId}...`);
    
    // Some SDKs just require userId to reset
    const resetRes = await snaptrade.authentication.resetSnapTradeUserSecret({
      userId
    } as any);
    console.log("Secret reset successful!");
    console.log("New Secret:", resetRes.data.userSecret);
    
  } catch (error: any) {
    console.error("Error resetting secret:", error.message || error);
    if (error.response) {
      console.error(error.response.data);
    }
  }
}

main();
