package org.firstinspires.ftc.robotcore.external.function;

import java.util.concurrent.Executor;

/** FTC SDK Continuation: a target object plus the executor the result should be delivered on. */
public class Continuation<T> {
    private final Executor executor; private final T target;
    protected Continuation(Executor executor, T target) { this.executor = executor; this.target = target; }
    public static <T> Continuation<T> create(Executor executor, T target) { return new Continuation<>(executor, target); }
    public static <T> Continuation<T> createTrivial(T target) { return new Continuation<>(Runnable::run, target); }
    public T getTarget() { return target; }
    public void dispatch(ContinuationResult<? super T> result) { executor.execute(() -> result.handle(target)); }
    public void dispatchHere(ContinuationResult<? super T> result) { result.handle(target); }
    public boolean isTrivial() { return true; }
}
