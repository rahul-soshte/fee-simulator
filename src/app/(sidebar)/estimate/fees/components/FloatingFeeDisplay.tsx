import React from 'react';
import { useState } from 'react';
import { useEffect } from 'react';

interface FloatingFeeDisplayProps {
  totalFee: number;
  network: any; // Pass network dynamically

}

export const FloatingFeeDisplay: React.FC<FloatingFeeDisplayProps> = ({ totalFee, network }) => {
  const [updatedFee, setUpdatedFee] = useState(totalFee);

  useEffect(() => {
    console.log("Network changed. Updating total fee display...");
    setUpdatedFee(totalFee);
  }, [network, totalFee]); // Recalculate fee when network changes

  return (
    <div
      style={{
        position: "fixed",
        top: "50%",
        right: "0",
        transform: "translateY(-50%)",
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        color: "white",
        padding: "15px",
        borderRadius: "5px 0 0 5px",
        zIndex: 1000,
        width: "150px",
        height: "150px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        boxShadow: "0 0 10px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{ marginBottom: "10px", fontSize: "14px" }}>Estimated Total Fee</div>
      <div style={{ fontSize: "18px", fontWeight: "bold" }}>{updatedFee.toFixed(7)} XLM</div>
    </div>
  );
};

export default FloatingFeeDisplay;