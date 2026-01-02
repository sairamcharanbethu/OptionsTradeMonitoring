
import fetch from 'node-fetch';

async function verifyForcePoll() {
    try {
        console.log('Triggering Force Poll...');
        const response = await fetch('http://localhost:3001/api/market/force-poll', {
            method: 'POST'
        });

        if (response.ok) {
            const data = await response.json();
            console.log('Success:', data);
        } else {
            console.error('Failed:', response.status, response.statusText);
            const text = await response.text();
            console.error('Response:', text);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

verifyForcePoll();
