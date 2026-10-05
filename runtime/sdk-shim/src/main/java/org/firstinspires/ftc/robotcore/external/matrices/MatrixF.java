package org.firstinspires.ftc.robotcore.external.matrices;

import org.firstinspires.ftc.robotcore.external.navigation.VectorF;

/** Minimal row-major float matrix with the FTC SDK's MatrixF surface. */
public class MatrixF {
    protected final int rows, cols; protected final float[] data;
    public MatrixF(int rows, int cols) { this.rows = rows; this.cols = cols; data = new float[rows * cols]; }
    public MatrixF(int rows, int cols, float[] data) { this.rows = rows; this.cols = cols; this.data = data.clone(); }
    public static MatrixF identityMatrix(int n) { MatrixF m = new MatrixF(n, n); for (int i = 0; i < n; i++) m.put(i, i, 1f); return m; }
    public float get(int row, int col) { return data[row * cols + col]; }
    public void put(int row, int col, float v) { data[row * cols + col] = v; }
    public int numRows() { return rows; }
    public int numCols() { return cols; }
    public float[] getData() { return data; }
    public MatrixF transposed() { MatrixF t = new MatrixF(cols, rows); for (int r = 0; r < rows; r++) for (int c = 0; c < cols; c++) t.put(c, r, get(r, c)); return t; }
    public MatrixF multiplied(MatrixF o) { MatrixF m = new MatrixF(rows, o.cols); for (int r = 0; r < rows; r++) for (int c = 0; c < o.cols; c++) { float s = 0; for (int k = 0; k < cols; k++) s += get(r, k) * o.get(k, c); m.put(r, c, s); } return m; }
    public VectorF multiplied(VectorF v) { float[] out = new float[rows]; for (int r = 0; r < rows; r++) { float s = 0; for (int c = 0; c < cols; c++) s += get(r, c) * v.get(c); out[r] = s; } return new VectorF(out); }
    public VectorF getRow(int r) { float[] o = new float[cols]; for (int c = 0; c < cols; c++) o[c] = get(r, c); return new VectorF(o); }
    public VectorF getColumn(int c) { float[] o = new float[rows]; for (int r = 0; r < rows; r++) o[r] = get(r, c); return new VectorF(o); }
    @Override public String toString() { StringBuilder sb = new StringBuilder(); for (int r = 0; r < rows; r++) { sb.append(r == 0 ? "[" : " "); for (int c = 0; c < cols; c++) sb.append(String.format("%7.3f", get(r, c))); sb.append(r == rows - 1 ? "]" : "\n"); } return sb.toString(); }
}
