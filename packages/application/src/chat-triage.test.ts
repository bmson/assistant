import { describe, expect, it } from 'vitest';
import { looksLikeActionRequest } from './chat-triage.js';

it('routes memory saves and receipt questions through the executor', () => {
  for (const text of [
    'I want you to remember our order, next time I ask you',
    'This is our order for you to remember. Two cheese pupusas.',
    'Was it save to long term memory',
  ])
    expect(looksLikeActionRequest(text)).toBe(true);
});

describe('looksLikeActionRequest', () => {
  it('routes short follow-ups with owner context to the executor', () => {
    expect(looksLikeActionRequest('Where are we staying')).toBe(true);
    expect(looksLikeActionRequest('What companies have I applied for?')).toBe(true);
    expect(
      looksLikeActionRequest('What is the address?', 'The card is saved.', [
        { role: 'user', parts: [{ type: 'text', text: 'Save my hotel reservation' }] },
      ]),
    ).toBe(true);
    expect(looksLikeActionRequest('What is the address?', 'The hotel is in Boston.')).toBe(false);
  });

  it.each(['Yes', 'Yes, go ahead', 'Please do', 'Do it', 'Keep going'])(
    'routes acceptance of a concrete action offer: %s',
    (text) => {
      expect(looksLikeActionRequest(text, 'I can search your email for the confirmation.')).toBe(
        true,
      );
      expect(looksLikeActionRequest(text, 'Would you like me to send that email?')).toBe(true);
      expect(looksLikeActionRequest(text, 'Do you like green?')).toBe(false);
      expect(looksLikeActionRequest(text, 'I already sent the email.')).toBe(false);
    },
  );

  it('catches clear action requests the weak classifier drops', () => {
    for (const t of [
      'add lunch Friday noon', // the reported prod miss
      'Add lunch friday',
      'please add lunch friday',
      'can you add this to my calendar',
      'could you please check my inbox',
      'remind me to call mom tomorrow',
      'schedule a meeting with Anna next week',
      'book a table for 2 on friday',
      'send an email to the team about the launch',
      'cancel my 3pm',
      'reschedule the dentist',
      'look up flights to Boston',
      'search for a birthday gift under $50',
      'put it on my calendar',
      'add milk to my shopping list',
      'unsubscribe me from that newsletter',
      'move my 3pm meeting to 4',
      'find me a good sushi place nearby',
    ]) {
      expect(looksLikeActionRequest(t), `should be an action: ${t}`).toBe(true);
    }
  });

  it('catches calendar/inbox read requests', () => {
    for (const t of [
      'look at my calendar and tell me the flight schedule for the next 3 weeks', // the reported prod miss
      "what's on my calendar this week",
      'show me my inbox',
      'go through my email and flag anything urgent',
      'tell me my schedule for tomorrow',
      'review my calendar for conflicts next month',
      'pull up my appointments for Friday',
      'can you look at my calendar and tell me when I fly',
      'anything urgent in my inbox?',
      'what do I have planned this weekend',
      'What is happening on Monday?',
      'When is my Clay interview?',
      // Receipt-shaped questions: mail arrives, it is not "checked". These name
      // no possessive surface, and some name no mail word at all — the reported
      // miss answered one of them from memory on the tool-less path.
      'Have I gotten an email about the hotel this weekend?',
      'Any email about my hotel booking?',
      'anything from the landlord?',
      'did Sarah ever get back to me',
      'Has the invoice arrived?',
      'has Clay emailed me yet?',
    ]) {
      expect(looksLikeActionRequest(t), `should be an action: ${t}`).toBe(true);
    }
  });

  it('routes a sports result question to the tools, never to memory', () => {
    // Answered without tools, this reached the owner as a stale score from
    // training data; the scores tool now answers it live.
    expect(looksLikeActionRequest('who won the game last night?')).toBe(true);
    expect(looksLikeActionRequest("what's the Giants score?")).toBe(true);
  });

  it('leaves plain conversation for the model to classify', () => {
    for (const t of [
      'what do you think about the plan?',
      'Why do interviews make me nervous?',
      'thanks, that helps!',
      'that makes sense',
      'how are you doing today?',
      'check this out',
      'I found that really funny',
      'explain how embeddings work',
      'why did that happen?',
      'nice work on the summary',
      'I looked at my calendar yesterday and it was busy', // past-tense recap — classifier still sees it
      "let's look at the numbers",
      'show me how embeddings work',
      "what's on your mind?",
      'I read the email you drafted, looks good',
      'has that ever happened to you?',
      'I got your email, thanks',
      '',
      '   ',
    ]) {
      expect(looksLikeActionRequest(t), `should be conversation: ${t}`).toBe(false);
    }
  });

  it('routes a failed-action follow-up back to the executor', () => {
    expect(
      looksLikeActionRequest(
        "I'm not seeing the change in these docs",
        "I'll update the contact info in both documents now.",
      ),
    ).toBe(true);
    expect(
      looksLikeActionRequest(
        'Those were not updated',
        'I updated both Google Docs with the new email address.',
      ),
    ).toBe(true);
  });

  it('routes calendar-verification follow-ups back to the executor', () => {
    expect(
      looksLikeActionRequest(
        'Was that made up?',
        'I checked your calendar and found a Linear interview.',
      ),
    ).toBe(true);
    expect(
      looksLikeActionRequest("Are you sure? I don't see it on my calendar", 'It is on Monday.'),
    ).toBe(true);
  });

  it('does not infer an action from a complaint without a prior action commitment', () => {
    expect(looksLikeActionRequest("I'm not seeing the change", 'That makes sense.')).toBe(false);
  });

  it('routes a forecast the ambient block cannot answer to the executor', () => {
    for (const t of [
      'How will the weather be tomorrow?', // the reported prod miss: invented a forecast
      'How will the weather be in San Francisco', // and then apologised for having none
      "what's the forecast for Tokyo this week",
      'will it rain in Boston tomorrow?',
      'is it going to snow this weekend?',
      'what is the temperature in Reykjavík?',
      'Check the weather in Tokyo tomorrow.',
      'Please check the weather.',
      'Look up the forecast for tomorrow',
    ]) {
      expect(looksLikeActionRequest(t), `should be a lookup: ${t}`).toBe(true);
    }
  });

  it('checks current weather even when ambient weather is missing or stale', () => {
    for (const t of ["what's the weather?", 'how is the weather right now', 'is it raining?'])
      expect(looksLikeActionRequest(t)).toBe(true);
  });

  it('leaves casual weather comments on the conversation path', () => {
    for (const t of ['ugh, rain all weekend', 'I love the rain on a Sunday']) {
      expect(looksLikeActionRequest(t), `should be conversation: ${t}`).toBe(false);
    }
  });
});
