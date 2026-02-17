using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class ConsolidateInviteTables : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Invites_AspNetUsers_CreatorId",
                table: "Invites");

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Invites",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");

            migrationBuilder.AlterColumn<string>(
                name: "CreatorId",
                table: "Invites",
                type: "text",
                nullable: true,
                oldClrType: typeof(string),
                oldType: "text");

            migrationBuilder.AddColumn<DateTime>(
                name: "CreatedAt",
                table: "Invites",
                type: "timestamp with time zone",
                nullable: false,
                defaultValue: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.AddColumn<DateTime>(
                name: "LastUsedAt",
                table: "Invites",
                type: "timestamp with time zone",
                nullable: true);

            // Migrate data from InviteCodes into unified Invites table (ServerId = NULL = global invite)
            migrationBuilder.Sql(@"
                INSERT INTO ""Invites"" (""Id"", ""Code"", ""ServerId"", ""CreatorId"", ""CreatedAt"", ""ExpiresAt"", ""MaxUses"", ""Uses"", ""LastUsedAt"")
                SELECT ""Id"", ""Code"", NULL, ""CreatedById"", ""CreatedAt"", ""ExpiresAt"", ""MaxUses"", ""Uses"", ""LastUsedAt""
                FROM ""InviteCodes""
            ");

            migrationBuilder.DropTable(
                name: "InviteCodes");

            migrationBuilder.AddForeignKey(
                name: "FK_Invites_AspNetUsers_CreatorId",
                table: "Invites",
                column: "CreatorId",
                principalTable: "AspNetUsers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Invites_AspNetUsers_CreatorId",
                table: "Invites");

            migrationBuilder.DropColumn(
                name: "CreatedAt",
                table: "Invites");

            migrationBuilder.DropColumn(
                name: "LastUsedAt",
                table: "Invites");

            migrationBuilder.AlterColumn<Guid>(
                name: "ServerId",
                table: "Invites",
                type: "uuid",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AlterColumn<string>(
                name: "CreatorId",
                table: "Invites",
                type: "text",
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "text",
                oldNullable: true);

            migrationBuilder.CreateTable(
                name: "InviteCodes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedById = table.Column<string>(type: "text", nullable: true),
                    Code = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastUsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    MaxUses = table.Column<int>(type: "integer", nullable: true),
                    Uses = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InviteCodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_InviteCodes_AspNetUsers_CreatedById",
                        column: x => x.CreatedById,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_InviteCodes_Code",
                table: "InviteCodes",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InviteCodes_CreatedById",
                table: "InviteCodes",
                column: "CreatedById");

            migrationBuilder.AddForeignKey(
                name: "FK_Invites_AspNetUsers_CreatorId",
                table: "Invites",
                column: "CreatorId",
                principalTable: "AspNetUsers",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
