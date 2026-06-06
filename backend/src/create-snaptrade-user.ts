import { Snaptrade } from "snaptrade-typescript-sdk";

const snaptrade = new Snaptrade({
  clientId: "PERS-8Q4PKK8U07RX1XSQM92Z",
  consumerKey: "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
});

async function createAndConnect() {
  try {
    const userId = "test_user_12345";
    console.log(`Registering new user: ${userId}...`);
    
    const registerRes = await snaptrade.authentication.registerSnapTradeUser({
      userId
    });
    
    const userSecret = registerRes.data.userSecret;
    console.log(`User created! Secret: ${userSecret}`);
    
    console.log("\nGenerating login link...");
    const loginRes = await snaptrade.authentication.loginSnapTradeUser({
      userId,
      userSecret
    });
    
    console.log(`Please visit this URL to connect your Wealthsimple account:\n${loginRes.data.loginRedirectURI}`);
    
  } catch (error: any) {
    console.error("Error connecting to SnapTrade:", error.message || error);
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error);
    }
  }
}

createAndConnect();
