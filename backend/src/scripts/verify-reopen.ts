
import axios from 'axios';

const BASE_URL = 'http://localhost:3001/api/positions';

async function verifyReopen() {
    try {
        console.log('1. Creating dummy position...');
        const createRes = await axios.post(BASE_URL, {
            symbol: 'TEST_REOPEN',
            option_type: 'CALL',
            strike_price: 100,
            expiration_date: '2026-01-01',
            entry_price: 10.0,
            quantity: 1,
            trailing_stop_loss_pct: 10 // 10% trailing stop
        });
        const position: any = createRes.data;
        console.log('Position created:', position.id, 'Entry:', position.entry_price, 'High:', position.trailing_high_price);

        console.log('2. Closing position...');
        await axios.post(`${BASE_URL}/${position.id}/close`, { price: 15.0 });

        console.log('3. Reopening position...');
        // PASS EMPTY BODY {} TO ENSURE JSON CONTENT-TYPE
        const reopenRes = await axios.patch(`${BASE_URL}/${position.id}/reopen`, {});
        const reopened: any = reopenRes.data;

        console.log('Reopened Position:', reopened);

        // VERIFICATION
        const isHighReset = Number(reopened.trailing_high_price) === Number(reopened.entry_price);
        const expectedStop = Number(reopened.entry_price) * (1 - 0.10); // 9.0
        const isStopReset = Number(reopened.stop_loss_trigger) === expectedStop;
        const isOpen = reopened.status === 'OPEN';

        console.log('---------------------------------------------------');
        console.log(`Status is OPEN: ${isOpen} (Expected: true)`);
        console.log(`Trailing High Reset to Entry (${reopened.entry_price}): ${isHighReset} (Val: ${reopened.trailing_high_price})`);
        console.log(`Stop Loss Trigger Recalculated (${expectedStop}): ${isStopReset} (Val: ${reopened.stop_loss_trigger})`);

        if (isOpen && isHighReset && isStopReset) {
            console.log('SUCCESS: Reopen logic verified.');
        } else {
            console.error('FAILURE: Reopen logic did not reset values correctly.');
            process.exit(1);
        }

        // Cleanup
        await axios.delete(`${BASE_URL}/${position.id}`);
        console.log('Cleanup complete.');

    } catch (err: any) {
        console.error('Test Failed:', err.response ? err.response.data : err.message);
        process.exit(1);
    }
}

verifyReopen();
