import { estimatedCostHandler } from '@/lib/estimated-cost-http-runtime';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => estimatedCostHandler(request, 'decision', true);
export const POST = (request: Request) => estimatedCostHandler(request, 'decision', true);
