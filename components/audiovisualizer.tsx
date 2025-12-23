

import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  isActive: boolean;
  color: string;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ isActive, color }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isActive) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const bars = 20;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;

      for (let i = 0; i < bars; i++) {
        const height = Math.random() * canvas.height * 0.8 + 5;
        const x = (canvas.width / bars) * i;
        const y = (canvas.height - height) / 2;
        const width = (canvas.width / bars) - 2;
        
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, 4);
        ctx.fill();
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={120} 
      height={40} 
      className="opacity-80 transition-opacity duration-300"
    />
  );
};

export default AudioVisualizer;
