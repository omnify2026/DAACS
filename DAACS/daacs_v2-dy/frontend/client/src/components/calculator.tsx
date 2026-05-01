import { useState } from "react";

type Operator = "+" | "-" | "*" | "/";

const initialState = {
  display: "0",
  storedValue: null as number | null,
  operator: null as Operator | null,
  waitingForOperand: false,
};

function compute(left: number, right: number, operator: Operator): number | null {
  if (operator === "+") return left + right;
  if (operator === "-") return left - right;
  if (operator === "*") return left * right;
  if (right === 0) return null;
  return left / right;
}

function Calculator() {
  const [display, setDisplay] = useState(initialState.display);
  const [storedValue, setStoredValue] = useState(initialState.storedValue);
  const [operator, setOperator] = useState(initialState.operator);
  const [waitingForOperand, setWaitingForOperand] = useState(
    initialState.waitingForOperand,
  );

  const reset = () => {
    setDisplay(initialState.display);
    setStoredValue(initialState.storedValue);
    setOperator(initialState.operator);
    setWaitingForOperand(initialState.waitingForOperand);
  };

  const handleDigit = (digit: string) => {
    if (display === "Error") {
      reset();
      setDisplay(digit);
      return;
    }

    if (waitingForOperand) {
      setDisplay(digit);
      setWaitingForOperand(false);
      return;
    }

    setDisplay(display === "0" ? digit : display + digit);
  };

  const handleOperator = (nextOperator: Operator) => {
    if (display === "Error") {
      return;
    }

    const inputValue = Number(display);

    if (storedValue === null) {
      setStoredValue(inputValue);
    } else if (operator && !waitingForOperand) {
      const result = compute(storedValue, inputValue, operator);
      if (result === null) {
        setDisplay("Error");
        setStoredValue(null);
        setOperator(null);
        setWaitingForOperand(true);
        return;
      }
      setStoredValue(result);
      setDisplay(String(result));
    }

    setOperator(nextOperator);
    setWaitingForOperand(true);
  };

  const handleEquals = () => {
    if (operator === null || storedValue === null || waitingForOperand) {
      return;
    }

    const result = compute(storedValue, Number(display), operator);
    if (result === null) {
      setDisplay("Error");
      setStoredValue(null);
      setOperator(null);
      setWaitingForOperand(true);
      return;
    }

    setDisplay(String(result));
    setStoredValue(null);
    setOperator(null);
    setWaitingForOperand(true);
  };

  const buttonClasses =
    "h-12 rounded-md border border-slate-200 bg-white text-slate-800 shadow-sm transition active:translate-y-px";
  const opClasses = `${buttonClasses} bg-slate-100 text-slate-900`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-xs rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 rounded-md border border-slate-200 bg-slate-100 px-3 py-4 text-right text-3xl font-mono text-slate-900">
          {display}
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button className={buttonClasses} onClick={() => handleDigit("7")}>
            7
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("8")}>
            8
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("9")}>
            9
          </button>
          <button className={opClasses} onClick={() => handleOperator("/")}>
            /
          </button>

          <button className={buttonClasses} onClick={() => handleDigit("4")}>
            4
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("5")}>
            5
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("6")}>
            6
          </button>
          <button className={opClasses} onClick={() => handleOperator("*")}>
            *
          </button>

          <button className={buttonClasses} onClick={() => handleDigit("1")}>
            1
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("2")}>
            2
          </button>
          <button className={buttonClasses} onClick={() => handleDigit("3")}>
            3
          </button>
          <button className={opClasses} onClick={() => handleOperator("-")}>
            -
          </button>

          <button className={buttonClasses} onClick={() => handleDigit("0")}>
            0
          </button>
          <button className={buttonClasses} onClick={reset}>
            C
          </button>
          <button className={opClasses} onClick={handleEquals}>
            =
          </button>
          <button className={opClasses} onClick={() => handleOperator("+")}>
            +
          </button>
        </div>
      </div>
    </div>
  );
}

export default Calculator;
