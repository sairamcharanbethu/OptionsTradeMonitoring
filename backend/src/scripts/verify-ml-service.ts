
import { spawn } from 'child_process';
import path from 'path';

async function verifyML() {
  console.log('Verifying ML Prediction Service...');
  const ticker = 'AAPL';
  const scriptPath = path.join(__dirname, 'predictor_service.py');

  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [scriptPath, ticker]);

    let dataString = '';
    let errorString = '';

    pythonProcess.stdout.on('data', (data) => {
      dataString += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorString += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Process exited with code ${code}`);
        console.error(`Stderr: ${errorString}`);
        reject(new Error('ML script failed'));
        return;
      }

      try {
        const lines = dataString.trim().split('\n');
        let result = null;

        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && (parsed.ticker || parsed.error)) {
              result = parsed;
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (result && !result.error) {
          console.log('Success! Received forecast for:', result.ticker);
          console.log('Forecast:', JSON.stringify(result.forecast));
          console.log('Indicators:', JSON.stringify(result.indicators));
          console.log('Expected Move:', result.expected_move);
          console.log('Confidence:', result.confidence);
          resolve(result);
        } else {
          console.error('No valid JSON output found or error returned:', result?.error);
          reject(new Error('Invalid output'));
        }
      } catch (e) {
        console.error('Failed to parse output:', e);
        reject(e);
      }
    });
  });
}

verifyML().then(() => {
  console.log('Verification complete.');
  process.exit(0);
}).catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
