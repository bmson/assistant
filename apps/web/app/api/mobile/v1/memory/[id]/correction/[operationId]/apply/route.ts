import { handleMobileOwnerMemoryCorrectionRequest } from '@/lib/mobile-owner-memory-correction-runtime';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> },
): Promise<Response> {
  const { id, operationId } = await params;
  return handleMobileOwnerMemoryCorrectionRequest(request, 'apply', {
    memoryId: id,
    operationId,
  });
}
