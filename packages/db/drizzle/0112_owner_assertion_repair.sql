-- Repair only owner-confirmed, canonical, exactly source-backed graph facts.
-- This does not promote inferred or imported unverified relationships.
UPDATE knowledge_graph_relations AS relation
SET assertion = canonical.assertion
FROM knowledge_graph_assertions AS canonical, memories AS memory
WHERE relation.assertion_id = canonical.id
  AND relation.agent_id = canonical.agent_id
  AND relation.subject_entity_id = canonical.subject_entity_id
  AND relation.object_entity_id = canonical.object_entity_id
  AND relation.predicate = canonical.predicate
  AND relation.source_memory_id = memory.id
  AND memory.agent_id = relation.agent_id
  AND memory.source = 'knowledge-graph-owner'
  AND memory.origin_trust = 'owner'
  AND memory.owner_confirmed = true
  AND canonical.owner_authored = true
  AND canonical.review_status = 'confirmed'
  AND canonical.reviewed_revision = canonical.semantic_revision
  AND canonical.reviewed_payload_hash = canonical.semantic_key
  AND canonical.lifecycle = 'current'
  AND canonical.assertion->>'modality' = 'asserted'
  AND relation.review_status = 'confirmed'
  AND relation.assertion->>'modality' = 'unverified'
  AND relation.evidence_quote = memory.content
  AND EXISTS (
    SELECT 1 FROM knowledge_graph_assertion_evidence AS evidence
    WHERE evidence.assertion_id = canonical.id
      AND evidence.agent_id = relation.agent_id
      AND evidence.source_memory_id = memory.id
      AND evidence.source_content_hash = memory.content_hash
      AND evidence.source_fingerprint = relation.source_fingerprint
      AND evidence.evidence_quote = memory.content
      AND evidence.source_author = 'owner'
      AND evidence.source_trust = 'owner'
  );
