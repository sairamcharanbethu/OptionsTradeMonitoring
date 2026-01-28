
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { spawn } from 'child_process';
import path from 'path';

export async function mlRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/forecast', {
    schema: {
      tags: ['AI'],
      summary: 'Get ML stock forecast',
      description: 'Retrieve ML-based price predictions, technical indicators, and sentiment for a given ticker.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['ticker'],
        properties: {
          ticker: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL)' }
        }
      }
    }
  }, async (request, reply) => {
    const { ticker } = request.query as { ticker: string };

    if (!ticker) {
      return reply.code(400).send({ error: 'Ticker is required' });
    }

    const scriptPath = path.join(__dirname, '../scripts/predictor_service.py');

    return new Promise((resolve) => {
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
        try {
          // Find the last valid JSON in the output (to avoid log noise from TF)
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

          if (result) {
            if (result.error) {
              reply.code(500).send({ error: result.error });
            } else {
              resolve(result);
            }
          } else {
            fastify.log.error(`Python script error (code ${code}): ${errorString}`);
            reply.code(500).send({ error: 'Failed to generate forecast', details: errorString });
          }
        } catch (e: any) {
          reply.code(500).send({ error: 'Error parsing forecast data', details: e.message });
        }
      });
    });
  });
}
