const API_BASE_URL = 'http://localhost:5001/api';

export const startCall = async (childName, situationHint) => {
    const response = await fetch(`${API_BASE_URL}/call/start`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            child_name: childName,
            situation_hint: situationHint, // Adjust key based on schema check
        }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || '통화 시작에 실패했습니다.');
    }

    return response.json();
};

export const generateResponse = async (sessionId, childName, parentText) => {
    const payload = {
        session_id: sessionId,
        child_name: childName,
        parent_text: parentText,
    };
    console.log("Sending generateResponse payload:", JSON.stringify(payload));

    const response = await fetch(`${API_BASE_URL}/generate-response`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("422 Validation Error Details:", JSON.stringify(errorData));
        throw new Error(errorData.detail || '응답 생성에 실패했습니다.');
    }

    return response.json();
};
