import { Snaptrade } from 'snaptrade-typescript-sdk';

const snaptrade = new Snaptrade({
    clientId: process.env.SNAPTRADE_CLIENT_ID || "PERS-8Q4PKK8U07RX1XSQM92Z",
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY || "6KyYeWMcv6UAYTUfkqJaKEn1IYgbXL7aWBtUlILoYALchsBS5X",
});

async function run() {
    try {
        const response = await snaptrade.authentication.registerSnapTradeUser({
            userId: "1"
        });
        console.log("Success:", response.data);
    } catch (e: any) {
        console.log(e.response?.data || e.message);
    }
}
run();
