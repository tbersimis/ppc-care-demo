# PPC (ΔΕΗ) customer care demo (Live Hub)

| Path | What it is |
|---|---|
| `/` | Greek customer care website with the web-call card and demo customers |
| `/backoffice/` | Κέντρο αιτημάτων: live requests, miles redemptions, customer balances |
| `POST /api/customer/lookup` | Tool `PPC_lookup_customer` (customer number + surname) |
| `POST /api/bills` | Tool `PPC_get_bills` (per supply: electricity or gas) |
| `POST /api/rewards` | Tool `PPC_get_rewards` |
| `POST /api/rewards/redeem` | Tool `PPC_redeem_miles` (300 miles = 1 EUR) |
| `POST /api/requests` | Tool `PPC_create_request` |
| `POST /api/requests/status` | Tool `PPC_request_status` |

The Live Hub agent **PPC_Care**, its six tools, the document **PPC_Customer_Care_Guide** and the
summary **PPC call summary** already exist in your account and point at `https://ppc-care-demo.onrender.com`.

All customers, bills and amounts are FICTITIOUS (see `customers.js`). Bills are generated relative to today.

## Deploy (same as the Coca-Cola HBC demo)

1. GitHub: new repository `ppc-care-demo`, upload everything inside the unzipped folder.
2. Render: New > Web Service > `ppc-care-demo`, Region Frankfurt, Node, build `npm install`, start `npm start`, Free.
   Optional environment variable `ADMIN_TOKEN`.
3. The address should be `https://ppc-care-demo.onrender.com`. If Render gives another one, ask Claude to update the six tools.

Render free plan: sleeps after 15 minutes idle (open `/backoffice/` first; it refreshes every 3 s and keeps
the app awake). When it restarts, the demo data (bills, miles, request history) is rebuilt.

## Logo

Upload the official PPC / ΔΕΗ logo to `public/brand/` as `logo.svg` or `logo.png`.

## Web calling (Click-to-Call)

1. Live Hub: new SIP connection, Provider Type **Client Applications**, Provider **Click-to-Call (WebRTC)**.
   On the Incoming tab tick **Credentials** and set a username and password (the widget needs a password).
2. Routing rule: from this SIP connection to the **PPC_Care** bot connection.
3. Download the widget files. Upload `click-to-call-widget.js` unchanged to `public/c2c/`.
4. Copy `public/c2c/c2c-config.example.js` to `public/c2c/c2c-config.js` and fill in the username, password,
   domain and wss address from the new `basic.js`. `CALL_NUMBER` is already `C2C-PPC-Call`.

## Demo customers

| Customer no. | Surname | Supplies | Good for |
|---|---|---|---|
| 300125 | Παπαδόπουλος | Electricity + gas | "Which supply?" question, bills, 6,400 miles to redeem |
| 300248 | Κωνσταντίνου | Electricity | Overdue bill: payment link or payment arrangement; Miles+Bonus not linked |
| 300376 | Ιωάννου | Electricity + gas | Standing order (paid automatically), 12,850 miles |
| 300419 | Γεωργίου | Electricity | Billing address change already in progress ("where is my request?"); not a myRewards member |
| 300552 | Miller | Electricity + gas | English speaker; name change awaiting documents |

## Demo script (Greek)

1. Open `/backoffice/`, wait for "Ζωντανά", click **Επαναφορά demo**.
2. Call from the website: «Θέλω να μάθω πόσο είναι ο λογαριασμός μου». Give 300125, Παπαδόπουλος.
   The agent asks: ρεύμα ή φυσικό αέριο;
3. «Πόσα μίλια έχω; Θέλω να βάλω τρεις χιλιάδες στον λογαριασμό του ρεύματος.» The credit appears on the board.
4. «Θέλω να αλλάξω τη διεύθυνση αποστολής των λογαριασμών.» A new request appears on the board.
5. Show the call's logs and the Greek post-call summary in Live Hub. Optionally call as 300552 in English.
