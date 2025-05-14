// test-ws.js
const {Web3} = require("web3");  // <- NOT { Web3 }

// your WS endpoint
const WS_URL = "ws://127.0.0.1:8546";

// 1) explicitly use the WebsocketProvider
const web3 = new Web3(WS_URL);

console.log("Web3 provider:", web3.currentProvider.getStatus());

// // 2) subscribe to new block headers
// const sub = web3.eth.subscribe("newBlockHeaders")
//   .on("data", header => {
//     console.log("New block #", header.number);
//   })
//   .on("error", err => {
//     console.error("Subscription error:", err);
//     process.exit(1);
//   });

// // 3) after 30s, cleanly unsubscribe and exit
// setTimeout(async () => {
//   try {
//     await sub.unsubscribe();           // returns a Promise
//     console.log("Unsubscribed cleanly");
//   } catch (err) {
//     console.error("Error during unsubscribe:", err);
//   }
//   process.exit(0);
// }, 30000);

async function subscribe() {
	//create subscription
	const subscription = await web3.eth.subscribe('newBlockHeaders'); //or ("newHeads")

	//print block header everytime a block is mined
	subscription.on('data', data => console.log(data));
}
subscribe();
