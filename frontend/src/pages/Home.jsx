import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_URL = 'http://127.0.0.1:8000/api/v1/sessions/';

function Home() {
  const [goal, setGoal] = useState('');
  const navigate = useNavigate();

  const startSession = async () => {
    if (!goal) return;
    try {
      await axios.post(API_URL, { goal });
      navigate('/dashboard');
    } catch (error) {
      console.error("Failed to start session", error);
    }
  };

  return (
    <div className="home-container">
      <h2>What are you working on today?</h2>
      <input 
        type="text" 
        placeholder="e.g. Study Python, write report..." 
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="goal-input"
      />
      <button onClick={startSession} className="start-btn">Start Focus Session</button>
    </div>
  );
}

export default Home;
