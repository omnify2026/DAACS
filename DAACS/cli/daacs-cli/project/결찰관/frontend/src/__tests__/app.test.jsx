import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

vi.mock('../speech/SpeechRecognizer', () => ({
  default: class MockSpeechRecognizer {
    constructor() {
      this.onResult = null;
      this.onError = null;
    }

    start() {}

    stop() {}
  },
}));

vi.mock('../audio/AudioPlayer', () => ({
  playBase64Audio: (_src, onEnded) => {
    if (typeof onEnded === 'function') {
      onEnded();
    }
  },
}));

describe('App (smoke)', () => {
  it('초기 진입 화면이 렌더링된다', () => {
    render(<App />);

    expect(screen.getByText('경찰관과 통화')).toBeInTheDocument();
    expect(screen.getByText('통화 시작')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('아이 이름')).toBeInTheDocument();
  });
});