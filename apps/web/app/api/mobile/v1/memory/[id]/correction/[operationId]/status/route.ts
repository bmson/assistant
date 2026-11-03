import { handleMobileOwnerMemoryCorrectionRequest } from '@/lib/mobile-owner-memory-correction-runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> },
): Promise<Response> {
  const { id, operationId } = await params;
  return handleMobileOwnerMemoryCorrectionRequest(request, 'status', {
    memoryId: id,
    operationId,
  });
}
